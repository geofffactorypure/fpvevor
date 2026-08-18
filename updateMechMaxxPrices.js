/**
 * updateMechMaxxPrices.js
 *
 * Fetches live pricing from mechmaxx.com's public Shopify storefront
 * (collections/all/products.json) and updates list price
 * for all already-listed MechMaxx products on our store.
 *
 * Pricing:
 *   List price   = MechMaxx store price  (price match)
 *   Variant cost = Dropship Pricing from mechmaxx-price-reset.csv (if SKU present)
 *
 * Usage:
 *   node updateMechMaxxPrices.js            # live update
 *   node updateMechMaxxPrices.js --dry-run  # preview only
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fs from 'fs'
import fetch from 'node-fetch'
import { parse } from 'csv-parse/sync'
import mysql from 'mysql'

// ── Config ───────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2026-01'
const VENDOR = 'MechMaxx'
const MECHMAXX_STORE_URL = 'https://mechmaxx.com/collections/all/products.json'
const DRY_RUN = process.argv.includes('--dry-run')
const CONCURRENCY = 5

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

// ── DB ───────────────────────────────────────────────────────────────────────
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

// ── MechMaxx Store Scrape ────────────────────────────────────────────────────

// Fetch one page from mechmaxx.com/collections/all/products.json
async function fetchMechMaxxPage(page) {
    const url = `${MECHMAXX_STORE_URL}?limit=250&page=${page}`
    const res = await fetch(url, {
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching MechMaxx page ${page}`)
    const data = await res.json()
    return data.products || []
}

// Paginate the entire MechMaxx catalog and return Map<sku, { price }>
async function fetchMechMaxxPrices() {
    const priceMap = new Map()
    let page = 1

    while (true) {
        console.log(`  Fetching MechMaxx store page ${page}...`)
        const products = await fetchMechMaxxPage(page)
        if (!products.length) break

        for (const product of products) {
            for (const variant of product.variants || []) {
                const sku = (variant.sku || '').trim()
                if (!sku) continue
                const price = parseFloat(variant.price) || 0
                if (!price) continue
                // Keep the first occurrence if duplicate SKUs exist across products
                if (!priceMap.has(sku)) {
                    priceMap.set(sku, { price })
                }
            }
        }

        console.log(`    → ${products.length} products, ${priceMap.size} SKUs so far`)
        if (products.length < 250) break
        page++
    }

    return priceMap
}

// ── Our Shopify Store ────────────────────────────────────────────────────────
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

// Paginate all listed MechMaxx variants from our Shopify store
// Returns Map<sku, { variantGid, productGid, currentPrice, currentCompareAt }>
async function fetchListedVariants(storeInfo) {
    const variantMap = new Map()
    let cursor = null
    let page = 0

    do {
        page++
        const data = await shopifyGraphQL(
            storeInfo,
            `query getProducts($cursor: String) {
                products(first: 250, after: $cursor, query: "vendor:'${VENDOR}'") {
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
                    currentPrice: parseFloat(v.price),
                })
            }
        }

        const hasNextPage = data.products.pageInfo.hasNextPage
        cursor = hasNextPage ? edges[edges.length - 1].cursor : null
        console.log(`  [our store] page ${page}: ${edges.length} products (${variantMap.size} total variants)`)
    } while (cursor)

    return variantMap
}

// Update variant price and optionally cost
async function updateVariant({ storeInfo, productGid, variantGid, price, cost }) {
    const variantInput = {
        id: variantGid,
        price: String(price),
    }
    if (cost !== undefined) {
        variantInput.inventoryItem = { cost: String(cost) }
    }

    const data = await shopifyGraphQL(
        storeInfo,
        `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                userErrors { field message }
            }
        }`,
        { productId: productGid, variants: [variantInput] }
    )
    const errors = data.productVariantsBulkUpdate?.userErrors
    if (errors?.length > 0) throw new Error(`Variant update errors: ${JSON.stringify(errors)}`)
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n═══ Update MechMaxx Prices ═══')
    console.log(`Dry Run: ${DRY_RUN}\n`)

    const pool = createPool()

    try {
        // 1. Fetch live prices from MechMaxx's Shopify store
        console.log('Fetching live prices from mechmaxx.com...')
        const mechMaxxPrices = await fetchMechMaxxPrices()
        console.log(`Fetched ${mechMaxxPrices.size} SKU(s) from MechMaxx store\n`)

        // 2. Load dealer costs from mechmaxx-price-reset.csv (Dropship Pricing column)
        //    SKU cells can contain multiple slash-separated values (e.g. 110200/110200Y)
        const costMap = new Map()
        const costCsvPath = new URL('./mechmaxx-price-reset.csv', import.meta.url)
        if (fs.existsSync(costCsvPath)) {
            const rows = parse(fs.readFileSync(costCsvPath, 'utf-8'), {
                columns: true,
                skip_empty_lines: true,
                relax_column_count: true,
                bom: true,
            })
            for (const row of rows) {
                const skuCell = row['SKU']?.trim() || ''
                const cost = parseFloat((row['Dropship Pricing'] || '').replace(/[^0-9.]/g, '')) || 0
                if (!skuCell || !cost) continue
                for (const s of skuCell.split('/')) {
                    const sku = s.trim()
                    if (sku) costMap.set(sku, cost)
                }
            }
            console.log(`Loaded ${costMap.size} dealer cost(s) from mechmaxx-price-reset.csv\n`)
        }

        // 3. Get store info
        const [storeInfo] = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)
        console.log(`Using store: ${storeInfo.shopify_name}`)

        // 4. Fetch all our listed MechMaxx variants
        console.log('\nFetching listed variants from our Shopify store...')
        const variantMap = await fetchListedVariants(storeInfo)
        console.log(`\nFetched ${variantMap.size} total variant(s)\n`)

        // 5. Match SKUs
        const toUpdate = []
        let notListedCount = 0
        let notInMechMaxxCount = 0

        for (const [sku, shopifyData] of variantMap) {
            const storeData = mechMaxxPrices.get(sku)
            if (!storeData) {
                notInMechMaxxCount++
                continue
            }
            toUpdate.push({
                sku,
                price: storeData.price,
                cost: costMap.get(sku),
                ...shopifyData,
            })
        }

        console.log(`${toUpdate.length} SKU(s) matched | ${notInMechMaxxCount} listed but not found in MechMaxx store`)

        if (toUpdate.length === 0) {
            console.log('Nothing to update. Exiting.')
            return
        }

        if (DRY_RUN) {
            console.log('\n[DRY RUN] Sample of planned updates (first 25):')
            for (const row of toUpdate.slice(0, 25)) {
                const priceTag =
                    row.price !== row.currentPrice
                        ? `$${row.currentPrice.toFixed(2)} → $${row.price.toFixed(2)}`
                        : `$${row.price.toFixed(2)} (unchanged)`
                const costTag = row.cost ? ` | cost=$${row.cost.toFixed(2)}` : ''
                console.log(`  [${row.sku}] price=${priceTag}${costTag}`)
            }
            console.log(`\n[DRY RUN] Would update ${toUpdate.length} variant(s). No changes made.`)
            return
        }

        // 6. Apply updates with concurrency limit
        console.log(`\nApplying updates (concurrency: ${CONCURRENCY})...`)
        let updated = 0
        let failed = 0
        let unchanged = 0

        for (let i = 0; i < toUpdate.length; i += CONCURRENCY) {
            const batch = toUpdate.slice(i, i + CONCURRENCY)
            await Promise.all(
                batch.map(async (row) => {
                    try {
                        await updateVariant({
                            storeInfo,
                            productGid: row.productGid,
                            variantGid: row.variantGid,
                            price: row.price,
                            cost: row.cost,
                        })
                        const priceChanged = row.price !== row.currentPrice
                        if (priceChanged) {
                            console.log(`  ✓ [${row.sku}] $${row.currentPrice.toFixed(2)} → $${row.price.toFixed(2)}`)
                        } else {
                            unchanged++
                        }
                        updated++
                    } catch (err) {
                        console.error(`  ✗ [${row.sku}] Failed: ${err.message}`)
                        failed++
                    }
                })
            )
        }

        console.log(
            `\nDone. Updated: ${updated} (${updated - unchanged} price changes, ${unchanged} refreshed), Failed: ${failed}`
        )
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
