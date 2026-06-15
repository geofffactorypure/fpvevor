import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import mysql from 'mysql'
import xlsx from 'xlsx'
import fs from 'fs'

/**
 * Vevor Cross-Sells Scraper
 *
 * Scrapes the "People Who Viewed This Item Also Viewed" section from Vevor
 * product pages and updates the custom.cross_sells metafield
 * (list.product_reference) in Shopify.
 *
 * Flow:
 *   1. Fetch Vevor feed to get product links + SKUs
 *   2. Match SKUs to existing products via variants_new -> products
 *   3. For each product page, extract the internal goodSn identifier
 *   4. Call Vevor's /api/recommend/look-and-look API to get cross-sell goodSn values
 *   5. Look up cross-sell SKUs in DB to get product GIDs
 *   6. Update Shopify custom.cross_sells metafield (list.product_reference)
 *
 * Usage:
 *   node scrapeVevorCrossSells.js [product_type] [--dry-run] [--limit=N]
 *
 * Examples:
 *   node scrapeVevorCrossSells.js
 *   node scrapeVevorCrossSells.js "Ultrasonic Cleaners" --limit=50
 *   node scrapeVevorCrossSells.js --dry-run
 */

// ── Config ──────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2026-01'
const PRODUCT_TYPE_FILTER =
    process.argv.find((a) => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]) || null
const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = parseInt((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || Infinity
const START_AFTER = (process.argv.find((a) => a.startsWith('--after=')) || '').split('=')[1] || null
const SCRAPE_DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS) || 0
const CONCURRENCY = parseInt(process.env.CONCURRENCY) || 5

const PROGRESS_FILE = new URL('./cross_sells_progress.txt', import.meta.url)

const VEVOR_ENDPOINT = process.env.VEVOR_ENDPOINT
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

// ── Shopify ─────────────────────────────────────────────────────────────────
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
            if (res.status === 429 || res.status >= 500) {
                throw new Error(`Shopify returned ${res.status}`)
            }
            return res.json()
        } catch (err) {
            if (attempt === retries) throw err
            const delay = 2000 * attempt
            console.log(
                `  [RETRY] Shopify request failed (attempt ${attempt}/${retries}): ${err.message}, retrying in ${delay}ms...`
            )
            await new Promise((resolve) => setTimeout(resolve, delay))
        }
    }
}

// ── Scraping ────────────────────────────────────────────────────────────────

/**
 * Extract the internal Vevor goodSn from a product page.
 * This is the alphanumeric ID (e.g. YTSZBJFB150LBSFBP001V1) needed for the API.
 */
async function getInternalGoodSn(productUrl) {
    const res = await fetch(productUrl, {
        headers: HEADERS,
        signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`Failed to fetch ${productUrl}: ${res.status}`)
    const html = await res.text()

    // Primary: data-sku on the ProductByAi element (most reliable)
    const aiMatch = html.match(/id="js-ProductByAi"[^>]*data-sku="([^"]+)"/)
    if (aiMatch) return aiMatch[1]

    // Fallback: first goodSn in the page
    const match = html.match(/goodSn['":\s]*['"]([A-Za-z0-9]{15,30})/)
    return match ? match[1] : null
}

/**
 * Fetch cross-sell SKUs (goodSn) from the Vevor look-and-look API ("also viewed").
 */
async function fetchCrossSellSkus(internalGoodSn) {
    const params = new URLSearchParams({
        bizType: 'goods_detail',
        goodSn: internalGoodSn,
        compType: 'viewed',
        pipeline: 'US',
        lang: 'en',
    })

    const res = await fetch(`https://www.vevor.com/api/recommend/look-and-look?${params}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`API returned ${res.status}`)
    const data = await res.json()

    if (data.status !== 0 || !data.data?.list?.length) return null

    const skus = data.data.list.map((item) => item.goodSn).filter((sn) => sn && sn.length > 0)
    return skus.length > 0 ? skus : null
}

/**
 * Fetch "customers also purchased" product IDs from our compare API.
 * Returns a Set of Shopify product IDs (numbers) to exclude from cross-sells.
 */
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

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const pool = createPool()

    try {
        console.log(`\n═══ Vevor Cross-Sells Scraper ═══`)
        console.log(`Product Type: ${PRODUCT_TYPE_FILTER || 'ALL'}`)
        console.log(`Dry Run: ${DRY_RUN}`)
        console.log(`Limit: ${LIMIT === Infinity ? 'none' : LIMIT}\n`)

        // 1. Get store info
        const [storeInfo] = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)

        // 2. Fetch the Vevor feed to get SKU -> product link mapping
        console.log('Fetching Vevor feed...')
        const res = await fetch(VEVOR_ENDPOINT)
        const buffer = await res.arrayBuffer()
        const workbook = xlsx.read(Buffer.from(buffer))
        const feedRows = xlsx.utils.sheet_to_json(workbook.Sheets.feed)
        console.log(`Feed has ${feedRows.length} total rows`)

        // Build SKU -> product link map from feed
        const skuToLink = new Map()
        for (const row of feedRows) {
            const sku = (row['SKU'] || '').trim()
            const link = (row['Product link'] || '').trim()
            if (sku && link) skuToLink.set(sku, link)
        }
        console.log(`Built link map for ${skuToLink.size} SKUs from feed`)

        // 3. Get all Vevor products from DB
        let productQuery = `
            SELECT p.id, p.title, p.product_type, p.admin_graphql_api_id,
                   vn.sku, vn.custom_weblinks
            FROM products p
            JOIN variants_new vn ON vn.product_id = p.id
            WHERE p.vendor = 'Vevor' AND p.store_id = ? AND vn.sku IS NOT NULL
        `
        const queryArgs = [STORE_ID]

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

        // 4. Build SKU -> product GID lookup for resolving cross-sell references
        const skuToProduct = new Map()
        for (const p of products) {
            skuToProduct.set(p.sku, {
                id: p.id,
                gid: p.admin_graphql_api_id || `gid://shopify/Product/${p.id}`,
            })
        }

        // 4b. Build product_type -> collection_id map for compare API
        const productTypes = [...new Set(products.map((p) => p.product_type).filter(Boolean))]
        const typeToCollection = new Map()
        if (productTypes.length > 0) {
            const collRows = await query(
                pool,
                `SELECT id, title FROM collections WHERE store_id = ? AND title IN (?)`,
                [STORE_ID, productTypes]
            )
            for (const row of collRows) {
                typeToCollection.set(row.title, row.id)
            }
            console.log(`Mapped ${typeToCollection.size} product type(s) to collection IDs for compare filtering`)
        }

        // 5. Match products to feed links
        const productsWithLinks = []
        for (const product of products) {
            let vevorUrl = skuToLink.get(product.sku)

            if (!vevorUrl && product.custom_weblinks) {
                try {
                    const weblinks = JSON.parse(product.custom_weblinks)
                    const link = weblinks.find((w) => typeof w.link === 'string' && w.link.includes('vevor.com'))
                    if (link) vevorUrl = link.link
                } catch (e) {
                    // ignore parse errors
                }
            }

            if (vevorUrl) {
                productsWithLinks.push({ ...product, vevorUrl })
            }
        }

        console.log(`Matched ${productsWithLinks.length} product(s) to Vevor URLs`)

        // Resume from --after flag or progress file
        let startAfterSku = START_AFTER
        if (!startAfterSku) {
            try {
                startAfterSku = fs.readFileSync(PROGRESS_FILE, 'utf-8').trim()
            } catch (e) {
                // no progress file
            }
        }

        let filtered = productsWithLinks
        if (startAfterSku) {
            const idx = filtered.findIndex((p) => p.sku === startAfterSku)
            if (idx !== -1) {
                filtered = filtered.slice(idx + 1)
                console.log(`Resuming after SKU ${startAfterSku} (skipping ${idx + 1} already processed)`)
            } else {
                console.log(`Warning: --after SKU ${startAfterSku} not found in list, starting from beginning`)
            }
        }

        const toProcess = filtered.slice(0, LIMIT)
        console.log(`Processing ${toProcess.length} product(s)...\n`)

        // 6. Scrape and update
        let successCount = 0
        let skipCount = 0
        let failCount = 0

        for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
            const batch = toProcess.slice(i, i + CONCURRENCY)

            const results = await Promise.allSettled(
                batch.map(async (product) => {
                    const { sku, vevorUrl, admin_graphql_api_id, title, id } = product

                    // Get internal goodSn from Vevor page, then fetch cross-sells via API
                    const internalGoodSn = await getInternalGoodSn(vevorUrl)
                    if (!internalGoodSn) {
                        console.log(`  [${sku}] Skip: could not extract goodSn from ${vevorUrl}`)
                        skipCount++
                        return
                    }

                    const crossSellSkus = await fetchCrossSellSkus(internalGoodSn)
                    if (!crossSellSkus || crossSellSkus.length === 0) {
                        console.log(`  [${sku}] Skip: no cross-sell data from Vevor API (goodSn: ${internalGoodSn})`)
                        skipCount++
                        return
                    }

                    // Resolve SKUs to product GIDs (only include products we have in our DB)
                    const crossSellGids = [
                        ...new Set(
                            crossSellSkus
                                .map((cs) => skuToProduct.get(cs))
                                .filter(Boolean)
                                .map((p) => p.gid)
                        ),
                    ]

                    if (crossSellGids.length === 0) {
                        console.log(`  [${sku}] Skip: ${crossSellSkus.length} cross-sell SKU(s) but none in our DB`)
                        skipCount++
                        return
                    }

                    // Exclude products already in "customers also purchased"
                    const collectionId = typeToCollection.get(product.product_type)
                    const compareIds = await fetchCompareProductIds(id, collectionId)
                    const filteredGids =
                        compareIds.size > 0
                            ? crossSellGids.filter((gid) => {
                                  const numId = parseInt(gid.split('/').pop())
                                  return !compareIds.has(numId)
                              })
                            : crossSellGids

                    if (filteredGids.length === 0) {
                        console.log(`  [${sku}] Skip: all ${crossSellGids.length} cross-sell(s) already in compare`)
                        skipCount++
                        return
                    }

                    if (DRY_RUN) {
                        const excluded = crossSellGids.length - filteredGids.length
                        console.log(
                            `  [${sku}] Found ${crossSellSkus.length} cross-sell(s), ${filteredGids.length} in DB${excluded > 0 ? ` (${excluded} excluded by compare)` : ''}:`
                        )
                        for (const gid of filteredGids) {
                            console.log(`    → ${gid}`)
                        }
                        successCount++
                        return
                    }

                    // Overwrite cross_sells with new data
                    const productGid = admin_graphql_api_id || `gid://shopify/Product/${id}`

                    // Update Shopify cross_sells metafield
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
                                    value: JSON.stringify(filteredGids),
                                    type: 'list.product_reference',
                                },
                            ],
                        }
                    )

                    const userErrors = result.data?.metafieldsSet?.userErrors
                    if (userErrors && userErrors.length > 0) {
                        throw new Error(`Shopify metafield errors: ${JSON.stringify(userErrors)}`)
                    }
                    if (result.errors) {
                        throw new Error(`Shopify GraphQL errors: ${JSON.stringify(result.errors)}`)
                    }

                    console.log(`  [${sku}] ✓ Cross-sells set (${filteredGids.length} products)`)
                    successCount++

                    // Save progress
                    fs.writeFileSync(PROGRESS_FILE, sku)
                })
            )

            for (const r of results) {
                if (r.status === 'rejected') {
                    failCount++
                    console.error(`  ✗ Error:`, r.reason?.message || r.reason)
                }
            }

            // Progress summary
            const processed = i + batch.length
            if (processed % 100 < CONCURRENCY || processed === toProcess.length) {
                console.log(
                    `  Progress: ${processed}/${toProcess.length} (${successCount} ok, ${skipCount} skip, ${failCount} fail)`
                )
            }

            // Rate limit between batches
            if (SCRAPE_DELAY_MS > 0 && i + CONCURRENCY < toProcess.length) {
                await new Promise((resolve) => setTimeout(resolve, SCRAPE_DELAY_MS))
            }
        }

        console.log(`\n✓ Done! ${successCount} updated, ${skipCount} skipped, ${failCount} failed.`)
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
