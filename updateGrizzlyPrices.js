/**
 * updateGrizzlyPrices.js
 *
 * Reads grizzly_price_list_latest.csv and updates Shopify list price, variant cost,
 * and inventory quantity for all already-listed Grizzly / Shop Fox / South Bend products.
 *
 * Pricing logic mirrors listGrizzlyProducts.js exactly.
 * List price = undercut of (MSRP + shipping cost) — the true delivered price from Grizzly.
 * Inventory: "Available" → 100 units, anything else → 0 units.
 *
 * Usage:
 *   node updateGrizzlyPrices.js                        # live update, all brands
 *   node updateGrizzlyPrices.js --dry-run              # preview only
 *   node updateGrizzlyPrices.js --brand "Shop Fox"     # limit to one brand
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import fetch from 'node-fetch'
import { parse } from 'csv-parse/sync'
import mysql from 'mysql'

// ── Config ──────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2026-01'
const DRY_RUN = process.argv.includes('--dry-run')
const CONCURRENCY = 5

const brandArgIdx = process.argv.indexOf('--brand')
const BRAND_FILTER = brandArgIdx !== -1 ? process.argv[brandArgIdx + 1]?.trim() : null

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

// ── Pricing Logic (mirrors listGrizzlyProducts.js) ─────────────────────────
const MIN_MARGIN = 0.1

// Shipping chart lookup for "See Chart" rows
function lookupShippingCost(dealerPrice) {
    if (dealerPrice >= 150) return 0
    if (dealerPrice >= 100) return 21.99
    if (dealerPrice >= 50) return 18.99
    if (dealerPrice >= 15) return 16.99
    return 8.99
}

function calcPrice({ msrp, dealerPrice, shippingCost, dealerMap }) {
    // effectiveMsrp = what a customer pays at Grizzly (list price + shipping)
    const effectiveMsrp = msrp + shippingCost
    const maxDiscount = Math.min(effectiveMsrp * 0.05, 10)
    const discounted = Math.round(effectiveMsrp - maxDiscount)
    const discountedMargin = discounted > 0 ? (discounted - dealerPrice - shippingCost) / discounted : 0
    const msrpFallback = discountedMargin >= 0.15 ? discounted : Math.round(effectiveMsrp)

    let price
    if (dealerMap > 0) {
        // effectiveMap = what a customer pays at Grizzly when buying at MAP (map + shipping)
        const effectiveMap = dealerMap + shippingCost
        const mapMaxDiscount = Math.min(effectiveMap * 0.05, 10)
        const discountedMap = Math.round(effectiveMap - mapMaxDiscount)
        const discountedMapMargin = discountedMap > 0 ? (discountedMap - dealerPrice - shippingCost) / discountedMap : 0
        const mapFallback = discountedMapMargin >= 0.15 ? discountedMap : Math.round(effectiveMap)
        const mapMargin = mapFallback > 0 ? (mapFallback - dealerPrice - shippingCost) / mapFallback : 0
        price = mapMargin >= MIN_MARGIN ? mapFallback : msrpFallback
    } else {
        price = msrpFallback
    }

    const margin = price > 0 ? (price - dealerPrice - shippingCost) / price : 0
    return { price, margin }
}

function normalizeBrand(brand) {
    if (!brand) return 'Grizzly'
    const b = brand.trim()
    if (b.toLowerCase().startsWith('grizzly')) return 'Grizzly'
    return b
}

// ── DB ──────────────────────────────────────────────────────────────────────
function createPool() {
    return mysql.createPool({
        connectionLimit: 5,
        host: DB_WRITE_HOST,
        user: DB_USER,
        password: DB_PASSWORD,
        port: 3306,
        database: 'main',
        timezone: '+00:00',
    })
}

function query(pool, sql, args = []) {
    return new Promise((resolve, reject) => {
        pool.query(sql, args, (err, results) => {
            if (err) return reject(err)
            resolve(results)
        })
    })
}

// ── Shopify ─────────────────────────────────────────────────────────────────
async function shopifyGraphQL(storeInfo, queryStr, variables = {}) {
    const res = await fetch(
        `https://${storeInfo.shopify_name}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': storeInfo.access_token,
            },
            body: JSON.stringify({ query: queryStr, variables }),
        }
    )
    const json = await res.json()
    if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`)
    return json.data
}

// Paginate all Grizzly/Shop Fox/South Bend variants from Shopify
// Returns Map<sku, { variantGid, productGid, inventoryItemId, currentPrice, hasSpecialPricing }>
async function fetchListedVariants(storeInfo) {
    const variantMap = new Map()
    const vendors = BRAND_FILTER ? [BRAND_FILTER] : ['Grizzly', 'Shop Fox', 'South Bend']

    for (const vendor of vendors) {
        let cursor = null
        let page = 0
        do {
            page++
            const data = await shopifyGraphQL(
                storeInfo,
                `query getProducts($cursor: String) {
                    products(first: 250, after: $cursor, query: "vendor:'${vendor}'") {
                        pageInfo { hasNextPage }
                        edges {
                            cursor
                            node {
                                id
                                tags
                                variants(first: 10) {
                                    nodes {
                                        id
                                        sku
                                        price
                                        inventoryItem { id }
                                    }
                                }
                            }
                        }
                    }
                }`,
                { cursor }
            )

            const edges = data.products.edges
            for (const edge of edges) {
                const hasSpecialPricing = (edge.node.tags || []).includes('grizzly_special_pricing')
                for (const v of edge.node.variants.nodes) {
                    const sku = (v.sku || '').trim()
                    if (!sku) continue
                    variantMap.set(sku, {
                        variantGid: v.id,
                        productGid: edge.node.id,
                        inventoryItemId: v.inventoryItem?.id || null,
                        currentPrice: parseFloat(v.price),
                        hasSpecialPricing,
                    })
                }
            }

            const hasNextPage = data.products.pageInfo.hasNextPage
            cursor = hasNextPage ? edges[edges.length - 1].cursor : null
            console.log(`  [${vendor}] page ${page}: ${edges.length} products (${variantMap.size} total variants)`)
        } while (cursor)
    }

    return variantMap
}

// Get the primary Shopify location ID
async function getPrimaryLocationId(storeInfo) {
    const data = await shopifyGraphQL(storeInfo, `query { locations(first: 1) { edges { node { id name } } } }`)
    const location = data.locations.edges[0]?.node
    if (!location) throw new Error('No location found in Shopify store')
    console.log(`Using location: ${location.name} (${location.id})`)
    return location.id
}

// Update variant price and cost; also enable tracking so inventory qty can be set
async function updateVariantPriceAndCost({ storeInfo, productGid, variantGid, price, cost }) {
    const data = await shopifyGraphQL(
        storeInfo,
        `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                userErrors { field message }
            }
        }`,
        {
            productId: productGid,
            variants: [
                {
                    id: variantGid,
                    price: String(price),
                    inventoryItem: { cost: String(cost), tracked: true },
                },
            ],
        }
    )
    const errors = data.productVariantsBulkUpdate?.userErrors
    if (errors?.length > 0) throw new Error(`Variant update errors: ${JSON.stringify(errors)}`)
}

// Set absolute inventory quantity at a location
async function setInventoryQuantity({ storeInfo, inventoryItemId, locationId, quantity }) {
    const data = await shopifyGraphQL(
        storeInfo,
        `mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) {
                inventoryAdjustmentGroup { id }
                userErrors { field message }
            }
        }`,
        {
            input: {
                name: 'available',
                reason: 'correction',
                ignoreCompareQuantity: true,
                quantities: [
                    {
                        inventoryItemId,
                        locationId,
                        quantity,
                    },
                ],
            },
        }
    )
    const errors = data.inventorySetQuantities?.userErrors
    if (errors?.length > 0) throw new Error(`Inventory set errors: ${JSON.stringify(errors)}`)
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n═══ Update Grizzly Prices ═══')
    console.log(`Dry Run: ${DRY_RUN}`)
    if (BRAND_FILTER) console.log(`Brand Filter: ${BRAND_FILTER}`)
    console.log()

    const pool = createPool()

    try {
        // 1. Load grizzly_price_list_latest.csv (row 1 is metadata; row 2 is headers)
        const __dirname = path.dirname(fileURLToPath(import.meta.url))
        const csvPath = path.join(__dirname, 'grizzly_price_list_latest.csv')
        console.log('Loading grizzly_price_list_latest.csv...')
        const csvContent = fs.readFileSync(csvPath, 'utf-8')
        const rows = parse(csvContent, {
            columns: true,
            skip_empty_lines: true,
            relax_column_count: true,
            relax_quotes: true,
            bom: true,
            from_line: 2,
        })
        console.log(`Loaded ${rows.length} rows from grizzly_price_list_latest.csv`)

        // 2. Parse rows and compute prices using same logic as listGrizzlyProducts.js
        const priceMap = new Map() // sku → pricing data

        for (const row of rows) {
            const sku = row['Item Number']?.trim()
            if (!sku) continue

            const csvBrand = row['Brand']?.trim() || ''
            const vendor = normalizeBrand(csvBrand)

            if (BRAND_FILTER && vendor !== BRAND_FILTER) continue

            const toNum = (val) => parseFloat((val || '').replace(/[^0-9.]/g, '')) || 0

            const msrp = toNum(row['MSRP'])
            const dealerPrice = toNum(row['Dealer Price'])
            const rawShipping = (row['Dealer Shipping Cost'] || '').trim()
            const shippingCost =
                rawShipping.toLowerCase() === 'see chart' ? lookupShippingCost(dealerPrice) : toNum(rawShipping)
            const dealerMap = toNum(row['Dealer MAP'])

            if (!msrp || !dealerPrice) continue

            const discontinued = row['Discontinued']?.trim().toLowerCase() === 'true'
            if (discontinued) continue

            const itemStatus = row['Item Status']?.trim() || ''
            const quantity = itemStatus.toLowerCase() === 'available' ? 100 : 0

            const { price, margin } = calcPrice({ msrp, dealerPrice, shippingCost, dealerMap })

            if (margin < MIN_MARGIN) {
                console.warn(
                    `[${sku}] Warning — margin ${(margin * 100).toFixed(1)}% is below 10% floor (updating anyway)`
                )
            }

            priceMap.set(sku, {
                price,
                cost: dealerPrice,
                shippingFee: shippingCost,
                mapPrice: dealerMap,
                msrp,
                quantity,
                vendor,
                itemStatus,
            })
        }

        console.log(`Parsed ${priceMap.size} SKUs with valid pricing from CSV`)

        // 3. Get store info
        const [storeInfo] = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)
        console.log(`Using store: ${storeInfo.shopify_name}`)

        // 4. Fetch all already-listed Grizzly variants from Shopify
        console.log('\nFetching listed variants from Shopify...')
        const variantMap = await fetchListedVariants(storeInfo)
        console.log(`\nFetched ${variantMap.size} total variant(s) from Shopify\n`)

        // 5. Match XLSX SKUs to listed Shopify variants
        const toUpdate = []
        let notListedCount = 0
        for (const [sku, priceData] of priceMap) {
            const shopifyData = variantMap.get(sku)
            if (!shopifyData) {
                notListedCount++
                continue
            }
            let { price, cost, shippingFee } = priceData
            if (shopifyData.hasSpecialPricing) {
                const minPrice = Math.ceil((cost + shippingFee) / (1 - MIN_MARGIN))
                if (price < minPrice) {
                    console.log(`[${sku}] grizzly_special_pricing: raising $${price} → $${minPrice} to hit ${(MIN_MARGIN * 100).toFixed(0)}% margin`)
                    price = minPrice
                }
            }
            toUpdate.push({ sku, ...priceData, price, ...shopifyData })
        }

        console.log(`${toUpdate.length} SKU(s) matched to listed products (${notListedCount} in XLSX not yet listed)`)

        if (toUpdate.length === 0) {
            console.log('Nothing to update. Exiting.')
            return
        }

        if (DRY_RUN) {
            console.log('\n[DRY RUN] Sample of planned updates (first 25):')
            for (const row of toUpdate.slice(0, 25)) {
                const priceChange =
                    Math.abs(row.currentPrice - row.price) > 0.01
                        ? ` (was $${row.currentPrice.toFixed(2)})`
                        : ' (unchanged)'
                console.log(
                    `  ${row.sku}: price=$${row.price.toFixed(2)}${priceChange}  cost=$${row.cost.toFixed(2)}  qty=${row.quantity} [${row.itemStatus}]`
                )
            }
            if (toUpdate.length > 25) console.log(`  … and ${toUpdate.length - 25} more`)
            return
        }

        // 6. Get primary location for inventory
        const locationId = await getPrimaryLocationId(storeInfo)
        console.log()

        // 7. Update in concurrent batches
        let successCount = 0
        let failCount = 0

        for (let i = 0; i < toUpdate.length; i += CONCURRENCY) {
            const batch = toUpdate.slice(i, i + CONCURRENCY)

            const results = await Promise.allSettled(
                batch.map(async (row) => {
                    // Update price and cost
                    await updateVariantPriceAndCost({
                        storeInfo,
                        productGid: row.productGid,
                        variantGid: row.variantGid,
                        price: row.price,
                        cost: row.cost,
                    })

                    // Set inventory quantity
                    if (row.inventoryItemId) {
                        await setInventoryQuantity({
                            storeInfo,
                            inventoryItemId: row.inventoryItemId,
                            locationId,
                            quantity: row.quantity,
                        })
                    } else {
                        console.warn(`[${row.sku}] No inventoryItemId — skipping inventory update`)
                    }

                    console.log(
                        `[${row.sku}] ✓ price=$${row.price.toFixed(2)}  cost=$${row.cost.toFixed(2)}  qty=${row.quantity} [${row.itemStatus}]`
                    )
                })
            )

            for (const r of results) {
                if (r.status === 'fulfilled') {
                    successCount++
                } else {
                    failCount++
                    console.error('  ✗ Update failed:', r.reason?.message || r.reason)
                }
            }
        }

        console.log(`\n✓ Done! ${successCount} updated, ${failCount} failed.`)
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
