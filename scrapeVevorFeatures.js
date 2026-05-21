import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import mysql from 'mysql'
import xlsx from 'xlsx'
import fs from 'fs'
import { JSDOM, VirtualConsole } from 'jsdom'

/**
 * Vevor Features Scraper
 *
 * Scrapes the "Features & Details" section from Vevor product pages and updates
 * both Shopify metafields and the database with the extracted bullet points.
 *
 * Flow:
 *   1. Fetch Vevor feed to get product links + SKUs
 *   2. Match SKUs to existing products via variants_new -> products
 *   3. Scrape each Vevor page for the features <ul> bullets
 *   4. Update Shopify custom.features metafield (list.single_line_text_field)
 *   5. Update products.custom_features in the database
 *
 * Usage:
 *   node scrapeVevorFeatures.js [product_type] [--dry-run] [--limit=N]
 *
 * Examples:
 *   node scrapeVevorFeatures.js
 *   node scrapeVevorFeatures.js "Ultrasonic Cleaners" --limit=50
 *   node scrapeVevorFeatures.js --dry-run
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
const CONCURRENCY = parseInt(process.env.CONCURRENCY) || 10

const PROGRESS_FILE = new URL('./features_progress.txt', import.meta.url)

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

async function updateShopifyFeatures(storeInfo, productGid, features) {
    const result = await shopifyGraphQL(
        storeInfo,
        `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
                userErrors { field message }
            }
        }`,
        {
            metafields: [
                {
                    ownerId: productGid,
                    namespace: 'custom',
                    key: 'features',
                    value: JSON.stringify(features),
                    type: 'list.single_line_text_field',
                },
            ],
        }
    )
    if (result.data?.metafieldsSet?.userErrors?.length > 0) {
        throw new Error(`Shopify metafield errors: ${JSON.stringify(result.data.metafieldsSet.userErrors)}`)
    }
    return result
}

// ── Scraping ────────────────────────────────────────────────────────────────
async function scrapeFeatures(productUrl) {
    const res = await fetch(productUrl, {
        headers: HEADERS,
        signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`Failed to fetch ${productUrl}: ${res.status}`)
    const html = await res.text()

    const virtualConsole = new VirtualConsole()
    const dom = new JSDOM(html, { virtualConsole })
    try {
        const document = dom.window.document
        const featuresList = document.querySelector('.detailGuide_cont.js-toggleCont')
        if (!featuresList) return null

        const items = Array.from(featuresList.querySelectorAll('li'))
        const features = items
            .map((li) => li.textContent.trim())
            .filter((text) => text.length > 0)
            .map((text) => text.replace(/【/g, '').replace(/】/g, ': ').trim())
            .filter((text) => text.length > 0)

        return features.length > 0 ? features : null
    } finally {
        dom.window.close()
    }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const pool = createPool()

    try {
        console.log(`\n═══ Vevor Features Scraper ═══`)
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

        // 3. Get all Vevor products from DB that need features
        let productQuery = `
            SELECT p.id, p.title, p.product_type, p.admin_graphql_api_id, p.custom_features,
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

        // 4. Match products to feed links
        const productsWithLinks = []
        for (const product of products) {
            // First try the feed link by SKU
            let vevorUrl = skuToLink.get(product.sku)

            // Fall back to weblinks metafield on the variant
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

        // 5. Scrape and update
        let successCount = 0
        let skipCount = 0
        let failCount = 0

        for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
            const batch = toProcess.slice(i, i + CONCURRENCY)

            const results = await Promise.allSettled(
                batch.map(async (product) => {
                    const { sku, vevorUrl, id, admin_graphql_api_id, title } = product

                    // Scrape features from Vevor page
                    const features = await scrapeFeatures(vevorUrl)
                    if (!features || features.length === 0) {
                        if (DRY_RUN) {
                            throw new Error(`No features found on page for ${sku}: ${vevorUrl}`)
                        }
                        console.log(`  [SKIP] ${sku} - no features found on page`)
                        skipCount++
                        return
                    }

                    console.log(`  [${sku}] Found ${features.length} feature(s):`)
                    for (const f of features) {
                        console.log(`    • ${f}`)
                    }

                    if (DRY_RUN) {
                        console.log(`  [DRY RUN] Would update ${title}`)
                        successCount++
                        return
                    }

                    // Update Shopify metafield
                    const productGid = admin_graphql_api_id || `gid://shopify/Product/${id}`
                    await updateShopifyFeatures(storeInfo, productGid, features)

                    // Update database
                    await query(pool, `UPDATE products SET custom_features = ? WHERE id = ?`, [
                        JSON.stringify(features),
                        id,
                    ])

                    console.log(`  [${sku}] ✓ Updated features (${features.length} bullets)`)
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

            // Rate limit between batches (if configured)
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
