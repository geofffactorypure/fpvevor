import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import mysql from 'mysql'
import fs from 'fs'

/**
 * MechMaxx Cross-Sells Scraper
 *
 * Scrapes the "Frequently Bought Together" section from MechMaxx product pages
 * and updates the custom.cross_sells metafield (list.product_reference) in Shopify.
 *
 * Flow:
 *   1. Get all MechMaxx products from DB (handle + admin_graphql_api_id)
 *   2. Build handle → product GID lookup for all MechMaxx products
 *   3. For each product page, parse .bought-together-right links → cross-sell handles
 *   4. Resolve handles to product GIDs (only products in our DB)
 *   5. Exclude products already in "customers also purchased" (compare API)
 *   6. Update Shopify custom.cross_sells metafield (list.product_reference)
 *
 * Usage:
 *   node scrapeMechMaxxCrossSells.js [product_type] [--dry-run] [--limit=N] [--after=SKU]
 *
 * Examples:
 *   node scrapeMechMaxxCrossSells.js
 *   node scrapeMechMaxxCrossSells.js "Wood Chippers" --limit=20
 *   node scrapeMechMaxxCrossSells.js --dry-run
 */

// ── Config ──────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2026-01'
const VENDOR = 'MechMaxx'
const MECHMAXX_BASE = 'https://mechmaxx.com'
const PRODUCT_TYPE_FILTER =
    process.argv.find((a) => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]) || null
const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = parseInt((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || Infinity
const START_AFTER = (process.argv.find((a) => a.startsWith('--after=')) || '').split('=')[1] || null
const SCRAPE_DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS) || 0
const CONCURRENCY = parseInt(process.env.CONCURRENCY) || 3

const PROGRESS_FILE = new URL('./mechmaxx_cross_sells_progress.txt', import.meta.url)

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
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

// ── Shopify ──────────────────────────────────────────────────────────────────
async function shopifyGraphQL(storeInfo, queryStr, variables, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
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
            if (res.status === 429 || res.status >= 500) throw new Error(`Shopify returned ${res.status}`)
            return res.json()
        } catch (err) {
            if (attempt === retries) throw err
            const delay = 2000 * attempt
            console.log(
                `  [RETRY] Shopify failed (attempt ${attempt}/${retries}): ${err.message}, retrying in ${delay}ms...`
            )
            await new Promise((r) => setTimeout(r, delay))
        }
    }
}
// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the mechmaxx.com product handle from a variant's custom_weblinks JSON.
 * Stored as: [{ link: "https://mechmaxx.com/products/{handle}", title: "..." }]
 */
function getMechMaxxHandle(customWeblinks) {
    if (!customWeblinks) return null
    try {
        const links = JSON.parse(customWeblinks)
        const link = links.find((w) => typeof w.link === 'string' && w.link.includes('mechmaxx.com/products/'))
        if (!link) return null
        const m = link.link.match(/mechmaxx\.com\/products\/([^/?#]+)/)
        return m ? m[1] : null
    } catch {
        return null
    }
}
// ── Scraping ──────────────────────────────────────────────────────────────────

/**
 * Scrape the "Frequently Bought Together" cross-sell handles from a MechMaxx product page.
 * Parses .bought-together-right .top-title-item anchor hrefs.
 * @param {string} mechmaxxHandle - The mechmaxx.com product handle (from custom_weblinks)
 * Returns mechmaxx.com handles of cross-sell products, excluding the current product itself.
 */
async function scrapeFbtHandles(mechmaxxHandle) {
    const productHandle = mechmaxxHandle
    const url = `${MECHMAXX_BASE}/products/${productHandle}`
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()

    const fbtIdx = html.toLowerCase().indexOf('frequently bought')
    if (fbtIdx === -1) return []

    const fbtSection = html.slice(fbtIdx, fbtIdx + 20000)
    const rightIdx = fbtSection.indexOf('bought-together-right')
    if (rightIdx === -1) return []

    const rightSection = fbtSection.slice(rightIdx, rightIdx + 10000)

    // Extract /products/[handle] hrefs from the right-side item list
    const handles = []
    const hrefRegex = /href="\/products\/([^"?#]+)/g
    let m
    while ((m = hrefRegex.exec(rightSection)) !== null) {
        const handle = m[1]
        if (handle !== productHandle && !handles.includes(handle)) {
            handles.push(handle)
        }
    }
    return handles
}

// ── Compare API ───────────────────────────────────────────────────────────────
async function fetchCompareProductIds(productId, collectionId) {
    if (!collectionId) return new Set()
    try {
        const params = new URLSearchParams({
            currency: 'USD',
            collection_id: String(collectionId),
            product_id: String(productId),
            limit: '30',
            order_by: 'relevance',
            include_filters: 'true',
        })
        const res = await fetch(`https://www.fpapplications.com/v2/compare?${params}`, {
            signal: AbortSignal.timeout(10000),
        })
        if (!res.ok) return new Set()
        const data = await res.json()
        if (!data.success || !data.products?.length) return new Set()
        return new Set(data.products.map((p) => p.id))
    } catch {
        return new Set()
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const pool = createPool()

    try {
        console.log(`\n═══ MechMaxx Cross-Sells Scraper ═══`)
        console.log(`Product Type: ${PRODUCT_TYPE_FILTER || 'ALL'}`)
        console.log(`Dry Run: ${DRY_RUN}`)
        console.log(`Limit: ${LIMIT === Infinity ? 'none' : LIMIT}\n`)

        // 1. Get store info
        const [storeInfo] = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)

        // 2. Get MechMaxx products to process (filtered by type if specified)
        let productQuery = `
            SELECT p.id, p.title, p.handle, p.product_type, p.admin_graphql_api_id,
                   vn.sku, vn.custom_weblinks
            FROM products p
            JOIN variants_new vn ON vn.product_id = p.id
            WHERE p.vendor = ? AND p.store_id = ? AND vn.sku IS NOT NULL
        `
        const queryArgs = [VENDOR, STORE_ID]
        if (PRODUCT_TYPE_FILTER) {
            productQuery += ` AND p.product_type = ?`
            queryArgs.push(PRODUCT_TYPE_FILTER)
        }
        productQuery += ` ORDER BY p.id`

        const products = await query(pool, productQuery, queryArgs)
        console.log(`Found ${products.length} product(s) to process`)

        if (products.length === 0) {
            console.log('Nothing to process. Exiting.')
            return
        }

        // 3. Build mechmaxx.com handle → { id, gid } lookup across ALL MechMaxx products
        //    (cross-sells may reference products not in the current type filter;
        //     handles come from custom_weblinks, not our Shopify handle)
        const allMechMaxx = await query(
            pool,
            `SELECT p.id, p.handle, p.admin_graphql_api_id, vn.custom_weblinks
             FROM products p
             JOIN variants_new vn ON vn.product_id = p.id
             WHERE p.vendor = ? AND p.store_id = ?`,
            [VENDOR, STORE_ID]
        )
        const mechmaxxHandleToProduct = new Map()
        for (const p of allMechMaxx) {
            const mxHandle = getMechMaxxHandle(p.custom_weblinks)
            if (mxHandle) {
                mechmaxxHandleToProduct.set(mxHandle, {
                    id: p.id,
                    gid: p.admin_graphql_api_id || `gid://shopify/Product/${p.id}`,
                })
            }
        }
        console.log(`Built mechmaxx handle map for ${mechmaxxHandleToProduct.size} product(s)`)

        // 4. Build product_type → collection_id for compare filtering
        const productTypes = [...new Set(products.map((p) => p.product_type).filter(Boolean))]
        const typeToCollection = new Map()
        if (productTypes.length > 0) {
            const collRows = await query(
                pool,
                `SELECT id, title FROM collections WHERE store_id = ? AND title IN (?)`,
                [STORE_ID, productTypes]
            )
            for (const row of collRows) typeToCollection.set(row.title, row.id)
            console.log(`Mapped ${typeToCollection.size} product type(s) to collection IDs`)
        }

        // 5. Resume from progress file or --after flag
        let startAfterSku = START_AFTER
        if (!startAfterSku) {
            try {
                startAfterSku = fs.readFileSync(PROGRESS_FILE, 'utf-8').trim()
            } catch {
                // no progress file yet
            }
        }

        let filtered = products
        if (startAfterSku) {
            const idx = filtered.findIndex((p) => p.sku === startAfterSku)
            if (idx !== -1) {
                filtered = filtered.slice(idx + 1)
                console.log(`Resuming after SKU ${startAfterSku} (skipping ${idx + 1})`)
            } else {
                console.log(`Warning: --after SKU ${startAfterSku} not found, starting from beginning`)
            }
        }

        const toProcess = filtered.slice(0, LIMIT)
        console.log(`Processing ${toProcess.length} product(s)...\n`)

        let successCount = 0,
            skipCount = 0,
            failCount = 0

        for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
            const batch = toProcess.slice(i, i + CONCURRENCY)

            await Promise.allSettled(
                batch.map(async (product) => {
                    const { sku, handle, admin_graphql_api_id, title, id } = product

                    try {
                        // Get mechmaxx.com handle from stored weblink
                        const mechmaxxHandle = getMechMaxxHandle(product.custom_weblinks)
                        if (!mechmaxxHandle) {
                            console.log(`  [${sku}] Skip: no mechmaxx.com weblink stored`)
                            skipCount++
                            return
                        }

                        // Scrape FBT cross-sell handles from MechMaxx product page
                        const crossSellHandles = await scrapeFbtHandles(mechmaxxHandle)

                        if (crossSellHandles.length === 0) {
                            console.log(`  [${sku}] Skip: no FBT section found`)
                            skipCount++
                            fs.writeFileSync(PROGRESS_FILE, sku)
                            return
                        }

                        // Resolve mechmaxx.com handles to GIDs (only products in our DB)
                        const crossSellGids = [
                            ...new Set(
                                crossSellHandles
                                    .map((h) => mechmaxxHandleToProduct.get(h))
                                    .filter(Boolean)
                                    .map((p) => p.gid)
                            ),
                        ]

                        if (crossSellGids.length === 0) {
                            console.log(
                                `  [${sku}] Skip: ${crossSellHandles.length} FBT handle(s) found but none in our DB`
                            )
                            skipCount++
                            fs.writeFileSync(PROGRESS_FILE, sku)
                            return
                        }

                        // Exclude products already in "customers also purchased"
                        const collectionId = typeToCollection.get(product.product_type)
                        const compareIds = await fetchCompareProductIds(id, collectionId)
                        const filteredGids =
                            compareIds.size > 0
                                ? crossSellGids.filter((gid) => !compareIds.has(parseInt(gid.split('/').pop())))
                                : crossSellGids

                        if (filteredGids.length === 0) {
                            console.log(`  [${sku}] Skip: all ${crossSellGids.length} cross-sell(s) already in compare`)
                            skipCount++
                            fs.writeFileSync(PROGRESS_FILE, sku)
                            return
                        }

                        const excluded = crossSellGids.length - filteredGids.length

                        if (DRY_RUN) {
                            console.log(
                                `  [${sku}] "${title.slice(0, 50)}" → ${filteredGids.length} cross-sell(s)` +
                                    (excluded > 0 ? ` (${excluded} excluded by compare)` : '')
                            )
                            for (const gid of filteredGids) console.log(`    → ${gid}`)
                            successCount++
                            return
                        }

                        const productGid = admin_graphql_api_id || `gid://shopify/Product/${id}`
                        const result = await shopifyGraphQL(
                            storeInfo,
                            `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
                                metafieldsSet(metafields: $metafields) {
                                    metafields { id }
                                    userErrors { field message }
                                }
                            }`,
                            {
                                metafields: [
                                    {
                                        ownerId: productGid,
                                        namespace: 'custom',
                                        key: 'cross_sells',
                                        type: 'list.product_reference',
                                        value: JSON.stringify(filteredGids),
                                    },
                                ],
                            }
                        )

                        const errors = result.data?.metafieldsSet?.userErrors
                        if (errors?.length) {
                            console.error(`  [${sku}] Shopify errors:`, errors)
                            failCount++
                        } else {
                            console.log(
                                `  [${sku}] ✓ Set ${filteredGids.length} cross-sell(s)` +
                                    (excluded > 0 ? ` (${excluded} excluded)` : '')
                            )
                            successCount++
                        }

                        fs.writeFileSync(PROGRESS_FILE, sku)
                    } catch (err) {
                        console.error(`  [${sku}] ✗ Error: ${err.message}`)
                        failCount++
                    }
                })
            )

            if (SCRAPE_DELAY_MS > 0 && i + CONCURRENCY < toProcess.length) {
                await new Promise((r) => setTimeout(r, SCRAPE_DELAY_MS))
            }
        }

        console.log(`\n── Summary ──────────────────────────────`)
        console.log(`  ✓ Success: ${successCount}`)
        console.log(`  ↷ Skipped: ${skipCount}`)
        console.log(`  ✗ Failed:  ${failCount}`)
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
