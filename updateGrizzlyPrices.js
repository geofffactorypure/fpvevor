/**
 * updateGrizzlyPrices.js
 *
 * Reads grizzly-price-update.xlsx and updates Shopify list price, variant cost,
 * and inventory quantity for all already-listed Grizzly / Shop Fox / South Bend products.
 *
 * Pricing logic mirrors listGrizzlyProducts.js exactly.
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
import fetch from 'node-fetch'
import xlsx from 'xlsx'
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

function calcPrice({ msrp, dealerPrice, shippingCost, dealerMap }) {
    const maxDiscount = Math.min(msrp * 0.05, 10)
    const discounted = Math.round(msrp - maxDiscount)
    const discountedMargin = discounted > 0 ? (discounted - dealerPrice - shippingCost) / discounted : 0
    const msrpFallback = discountedMargin >= 0.15 ? discounted : Math.round(msrp)

    let price
    if (dealerMap > 0) {
        const mapMargin = (dealerMap - dealerPrice - shippingCost) / dealerMap
        price = mapMargin >= MIN_MARGIN ? dealerMap : msrpFallback
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
// Returns Map<sku, { variantGid, productGid, inventoryItemId, currentPrice }>
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
                for (const v of edge.node.variants.nodes) {
                    const sku = (v.sku || '').trim()
                    if (!sku) continue
                    variantMap.set(sku, {
                        variantGid: v.id,
                        productGid: edge.node.id,
                        inventoryItemId: v.inventoryItem?.id || null,
                        currentPrice: parseFloat(v.price),
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
    const data = await shopifyGraphQL(
        storeInfo,
        `query { locations(first: 1) { edges { node { id name } } } }`
    )
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
        // 1. Load XLSX
        const __dirname = path.dirname(fileURLToPath(import.meta.url))
        const xlsxPath = path.join(__dirname, 'grizzly-price-update.xlsx')
        console.log('Loading grizzly-price-update.xlsx...')
        const workbook = xlsx.readFile(xlsxPath)
        const ws = workbook.Sheets['Price List']
        if (!ws) throw new Error('Sheet "Price List" not found in grizzly-price-update.xlsx')

        // Row 0 is a "Pricing effective..." notice; row 1 is the actual column header row
        const rows = xlsx.utils.sheet_to_json(ws, { range: 1, defval: null })
        console.log(`Loaded ${rows.length} rows from "Price List" sheet`)

        // 2. Parse rows and compute prices using same logic as listGrizzlyProducts.js
        const priceMap = new Map() // sku → pricing data

        for (const row of rows) {
            const sku = row['Item Number']?.toString().trim()
            if (!sku) continue

            const csvBrand = row['Brand']?.toString().trim() || ''
            const vendor = normalizeBrand(csvBrand)

            if (BRAND_FILTER && vendor !== BRAND_FILTER) continue

            // Numeric columns come through as numbers from xlsx; strings like "See Chart" default to 0
            const toNum = (val) =>
                typeof val === 'number' ? val : parseFloat((val || '').toString().replace(/[^0-9.]/g, '')) || 0

            const msrp = toNum(row['MSRP'])
            const dealerPrice = toNum(row['Dealer Price'])
            const shippingCost = toNum(row['Dealer Shipping Cost'])
            const dealerMap = toNum(row['Dealer MAP'])

            if (!msrp || !dealerPrice) continue

            const itemStatus = row['Item Status']?.toString().trim() || ''
            const quantity = itemStatus.toLowerCase() === 'available' ? 100 : 0

            const { price, margin } = calcPrice({ msrp, dealerPrice, shippingCost, dealerMap })

            if (margin < MIN_MARGIN) {
                console.warn(`[${sku}] Skipping — margin ${(margin * 100).toFixed(1)}% is below 10% floor`)
                continue
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

        console.log(`Parsed ${priceMap.size} SKUs with valid pricing from XLSX`)

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
            toUpdate.push({ sku, ...priceData, ...shopifyData })
        }

        console.log(
            `${toUpdate.length} SKU(s) matched to listed products (${notListedCount} in XLSX not yet listed)`
        )

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
