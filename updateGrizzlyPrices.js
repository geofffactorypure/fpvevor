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
const DELIVERY_PROFILE_NAME = 'FactoryPure Shipping'

const brandArgIdx = process.argv.indexOf('--brand')
const BRAND_FILTER = brandArgIdx !== -1 ? process.argv[brandArgIdx + 1]?.trim() : null

const limitArgIdx = process.argv.indexOf('--limit')
const LIMIT = (() => {
    // Support both --limit=1 and --limit 1
    const eqArg = process.argv.find((a) => a.startsWith('--limit='))
    if (eqArg) return parseInt(eqArg.split('=')[1]) || 1
    const spaceIdx = process.argv.indexOf('--limit')
    if (spaceIdx !== -1) return parseInt(process.argv[spaceIdx + 1]) || 1
    return Infinity
})()

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

// ── Pricing Logic (mirrors listGrizzlyProducts.js) ─────────────────────────
const MIN_MARGIN = 0.07
const TARGET_CROSS_SELL_MARGIN = 0.1

// Shipping chart lookup for "See Chart" rows
function lookupShippingCost(dealerPrice) {
    if (dealerPrice >= 150) return 0
    if (dealerPrice >= 100) return 21.99
    if (dealerPrice >= 50) return 18.99
    if (dealerPrice >= 15) return 16.99
    return 8.99
}

// Price formatting helpers — all Grizzly prices end in .95
const to95 = (p) => Math.floor(p - 0.95) + 0.95 // largest  .95 price ≤ p (use for discounts)
const to95Ceil = (p) => Math.ceil(p - 0.95) + 0.95 // smallest .95 price ≥ p (use for MAP floors)
const to99 = (p) => Math.floor(p - 0.99) + 0.99 // largest  .99 price ≤ p (use for shipping)

function calcPrice({ msrp, dealerPrice, shippingCost, dealerMap }) {
    // Shipping always goes to the custom.shipping_fee metafield — never baked into list price.
    // Margin = (price - dealerPrice) / (price + shippingCost)
    // Customer pays price + shippingCost (via carrier service), we pay dealerPrice + shippingCost.
    const calcMgn = (p) => (p + shippingCost > 0 ? (p - dealerPrice) / (p + shippingCost) : 0)

    // No-MAP path: undercut MSRP by up to 5% (capped at $10); use discounted price if margin >= 15%
    const maxDiscount = Math.min(msrp * 0.05, 10)
    const discounted = to95(msrp - maxDiscount)
    const msrpFallback = calcMgn(discounted) >= 0.15 ? discounted : to95(msrp)

    let price
    if (dealerMap > 0) {
        // MAP path: list price = lowest .95 price at or above MAP.
        // Fall back to msrpFallback if MAP can't clear MIN_MARGIN (MAP is a floor, not a ceiling).
        const mapPrice = to95Ceil(dealerMap)
        price = calcMgn(mapPrice) >= MIN_MARGIN ? mapPrice : msrpFallback
    } else {
        price = msrpFallback
    }

    const margin = calcMgn(price)
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

// Set custom.shipping_fee metafield on a variant
async function setShippingFeeMetafield({ storeInfo, variantGid, shippingFee }) {
    const data = await shopifyGraphQL(
        storeInfo,
        `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
                userErrors { field message }
            }
        }`,
        {
            metafields: [
                {
                    ownerId: variantGid,
                    namespace: 'custom',
                    key: 'shipping_fee',
                    type: 'number_decimal',
                    value: String(shippingFee),
                },
            ],
        }
    )
    const errors = data.metafieldsSet?.userErrors
    if (errors?.length > 0) throw new Error(`Metafield set errors: ${JSON.stringify(errors)}`)
}

async function setCustomerShippingFeeMetafield({ storeInfo, variantGid, customerShippingFee }) {
    const data = await shopifyGraphQL(
        storeInfo,
        `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
                userErrors { field message }
            }
        }`,
        {
            metafields: [
                {
                    ownerId: variantGid,
                    namespace: 'custom',
                    key: 'customer_shipping_fee',
                    type: 'number_decimal',
                    value: String(customerShippingFee),
                },
            ],
        }
    )
    const errors = data.metafieldsSet?.userErrors
    if (errors?.length > 0) throw new Error(`Metafield set errors: ${JSON.stringify(errors)}`)
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

// Find a delivery profile by name; returns its GID or null
async function fetchDeliveryProfileId(storeInfo, name) {
    let cursor = null
    do {
        const data = await shopifyGraphQL(
            storeInfo,
            `query($cursor: String) {
                deliveryProfiles(first: 20, after: $cursor) {
                    pageInfo { hasNextPage }
                    edges {
                        cursor
                        node { id name }
                    }
                }
            }`,
            { cursor }
        )
        for (const edge of data.deliveryProfiles.edges) {
            if (edge.node.name === name) return edge.node.id
        }
        cursor = data.deliveryProfiles.pageInfo.hasNextPage ? data.deliveryProfiles.edges.at(-1).cursor : null
    } while (cursor)
    return null
}

// Add variant GIDs to an existing delivery profile
async function assignVariantsToDeliveryProfile(storeInfo, profileId, variantGids) {
    const data = await shopifyGraphQL(
        storeInfo,
        `mutation deliveryProfileUpdate($id: ID!, $profile: DeliveryProfileInput!) {
            deliveryProfileUpdate(id: $id, profile: $profile) {
                profile { id name }
                userErrors { field message }
            }
        }`,
        { id: profileId, profile: { variantsToAssociate: variantGids } }
    )
    const errors = data.deliveryProfileUpdate?.userErrors
    if (errors?.length > 0) throw new Error(`Delivery profile update errors: ${JSON.stringify(errors)}`)
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

        // 2. Load grizzly_unlisted_cross_sells.csv for cross-sell price rescue
        const crossSellsCsvPath = new URL('./grizzly_unlisted_cross_sells.csv', import.meta.url)
        const crossSellSkuSet = new Set()
        if (fs.existsSync(crossSellsCsvPath)) {
            const csRows = parse(fs.readFileSync(crossSellsCsvPath, 'utf-8'), {
                columns: true,
                skip_empty_lines: true,
                relax_column_count: true,
                relax_quotes: true,
                bom: true,
            })
            for (const r of csRows) {
                const s = r['accessory_sku']?.trim()
                if (s && (r['listed'] || '').toLowerCase() !== 'yes') crossSellSkuSet.add(s.toUpperCase())
            }
            console.log(`Loaded ${crossSellSkuSet.size} unlisted cross-sell SKUs from grizzly_unlisted_cross_sells.csv`)
        }

        // 3. Parse rows and compute prices using same logic as listGrizzlyProducts.js
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

            let { price, margin } = calcPrice({ msrp, dealerPrice, shippingCost, dealerMap })

            // Cross-sell rescue: raise to 10% margin if SKU is an unlisted cross-sell
            if (crossSellSkuSet.has(sku.toUpperCase()) && margin < TARGET_CROSS_SELL_MARGIN) {
                // Solve (p - dealerPrice) / (p + shippingCost) = TARGET → p = (dealerPrice + TARGET * shippingCost) / (1 - TARGET)
                const minPrice = Math.ceil(
                    (dealerPrice + TARGET_CROSS_SELL_MARGIN * shippingCost) / (1 - TARGET_CROSS_SELL_MARGIN)
                )
                if (minPrice > price) {
                    console.log(
                        `[${sku}] cross-sell rescue: $${price} → $${minPrice} (margin ${(margin * 100).toFixed(1)}% → ${TARGET_CROSS_SELL_MARGIN * 100}%)`
                    )
                    price = minPrice
                    margin = (price - dealerPrice) / (price + shippingCost)
                }
            }

            if (margin < MIN_MARGIN) {
                console.warn(
                    `[${sku}] Warning — margin ${(margin * 100).toFixed(1)}% is below ${(MIN_MARGIN * 100).toFixed(0)}% floor (updating anyway)`
                )
            }

            // Undercut strategy:
            // - MSRP items: price discount already applied in calcPrice (up to 5% / $10 off MSRP)
            // - MAP items: price is locked at MAP, so undercut on customer shipping instead
            let customerShippingFee = shippingCost
            if (dealerMap > 0) {
                const shipDiscount = Math.min(shippingCost * 0.05, 10)
                const discountedShipping = Math.max(shippingCost - shipDiscount, 0)
                const discountedMargin =
                    (price + discountedShipping - dealerPrice - shippingCost) / (price + discountedShipping)
                if (discountedMargin >= MIN_MARGIN) {
                    customerShippingFee = to99(discountedShipping)
                    console.log(
                        `[${sku}] MAP shipping undercut: $${shippingCost.toFixed(2)} → $${customerShippingFee.toFixed(2)} (margin ${(discountedMargin * 100).toFixed(1)}%)`
                    )
                }
            }

            priceMap.set(sku, {
                price,
                cost: dealerPrice,
                shippingFee: shippingCost,
                customerShippingFee,
                mapPrice: dealerMap,
                msrp,
                quantity,
                vendor,
                itemStatus,
            })
        }

        console.log(`Parsed ${priceMap.size} SKUs with valid pricing from CSV`)

        // 4. Get store info
        const [storeInfo] = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)
        console.log(`Using store: ${storeInfo.shopify_name}`)

        // 5. Fetch all already-listed Grizzly variants from Shopify
        console.log('\nFetching listed variants from Shopify...')
        const variantMap = await fetchListedVariants(storeInfo)
        console.log(`\nFetched ${variantMap.size} total variant(s) from Shopify\n`)

        // 6. Match XLSX SKUs to listed Shopify variants
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
                // margin = (price + customerShippingFee - cost - shippingFee) / (price + customerShippingFee)
                // When customerShippingFee == shippingFee: (price - cost) / (price + shippingFee)
                // Solve for p at MIN_MARGIN: p = (cost + MIN_MARGIN * shippingFee) / (1 - MIN_MARGIN)
                const minPrice = Math.ceil((cost + MIN_MARGIN * shippingFee) / (1 - MIN_MARGIN))
                if (price < minPrice) {
                    console.log(
                        `[${sku}] grizzly_special_pricing: raising $${price} → $${minPrice} to hit ${(MIN_MARGIN * 100).toFixed(0)}% margin`
                    )
                    price = minPrice
                }
            }
            // Revenue = price + customerShippingFee; cost to us = cost + shippingFee
            // Since customerShippingFee == shippingFee: margin = (price - cost) / (price + shippingFee)
            let { customerShippingFee } = priceData
            const finalMargin =
                price + customerShippingFee > 0
                    ? (price + customerShippingFee - cost - shippingFee) / (price + customerShippingFee)
                    : 0
            const { quantity } = priceData
            if (finalMargin < 0.07) {
                // Warn only — CSV Item Status drives inventory
                console.warn(
                    `[${sku}] Low margin ${(finalMargin * 100).toFixed(1)}% (price $${price}, cost $${cost}, ship-dealer $${shippingFee}, ship-customer $${customerShippingFee})`
                )
            }
            toUpdate.push({ sku, ...priceData, price, quantity, ...shopifyData })
        }

        console.log(`${toUpdate.length} SKU(s) matched to listed products (${notListedCount} in XLSX not yet listed)`)

        if (toUpdate.length === 0) {
            console.log('Nothing to update. Exiting.')
            return
        }

        // Apply limit if set
        const batch = LIMIT < Infinity ? toUpdate.slice(0, LIMIT) : toUpdate
        if (LIMIT < Infinity) console.log(`\n--limit=${LIMIT}: processing ${batch.length} SKU(s)\n`)

        if (DRY_RUN) {
            console.log('\n[DRY RUN] Sample of planned updates (first 25):')
            for (const row of batch.slice(0, 25)) {
                const priceChange =
                    Math.abs(row.currentPrice - row.price) > 0.01
                        ? ` (was $${row.currentPrice.toFixed(2)})`
                        : ' (unchanged)'
                console.log(
                    `  ${row.sku}: price=$${row.price.toFixed(2)}${priceChange}  cost=$${row.cost.toFixed(2)}  qty=${row.quantity} [${row.itemStatus}]`
                )
            }
            if (batch.length > 25) console.log(`  … and ${batch.length - 25} more`)
            return
        }

        // 7. Get primary location for inventory
        const locationId = await getPrimaryLocationId(storeInfo)

        // Look up the FactoryPure Shipping delivery profile
        console.log(`\nLooking up "${DELIVERY_PROFILE_NAME}" delivery profile...`)
        const deliveryProfileId = await fetchDeliveryProfileId(storeInfo, DELIVERY_PROFILE_NAME)
        if (deliveryProfileId) {
            console.log(`Found delivery profile: ${deliveryProfileId}`)
        } else {
            console.warn(`Delivery profile "${DELIVERY_PROFILE_NAME}" not found — skipping profile assignment`)
        }
        console.log()

        // 8. Update in concurrent batches
        let successCount = 0
        let failCount = 0

        for (let i = 0; i < batch.length; i += CONCURRENCY) {
            const chunk = batch.slice(i, i + CONCURRENCY)

            const results = await Promise.allSettled(
                chunk.map(async (row) => {
                    // Update price and cost
                    await updateVariantPriceAndCost({
                        storeInfo,
                        productGid: row.productGid,
                        variantGid: row.variantGid,
                        price: row.price,
                        cost: row.cost,
                    })

                    // Set dealer shipping fee and customer shipping fee metafields on the variant
                    await setShippingFeeMetafield({
                        storeInfo,
                        variantGid: row.variantGid,
                        shippingFee: row.shippingFee,
                    })
                    await setCustomerShippingFeeMetafield({
                        storeInfo,
                        variantGid: row.variantGid,
                        customerShippingFee: row.customerShippingFee,
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

                    // Assign to shipping profile immediately after update
                    if (deliveryProfileId) {
                        await assignVariantsToDeliveryProfile(storeInfo, deliveryProfileId, [row.variantGid])
                    }

                    console.log(
                        `[${row.sku}] ✓ price=$${row.price.toFixed(2)}  cost=$${row.cost.toFixed(2)}  ship-dealer=$${row.shippingFee.toFixed(2)}  ship-customer=$${row.customerShippingFee.toFixed(2)}  qty=${row.quantity} [${row.itemStatus}]`
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
