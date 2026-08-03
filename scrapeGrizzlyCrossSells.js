import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import mysql from 'mysql'
import fs from 'fs'
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'

/**
 * Grizzly Cross-Sells Scraper
 *
 * For every listed Grizzly/Shop Fox/South Bend product, fetches the product
 * page and reads window.product.Accessories to get the accessory SKU list.
 *
 * Flow:
 *   1. Get all listed Grizzly-family products from DB
 *   2. For each, fetch the Grizzly page and read Accessories from window.product JSON
 *   3. Deduplicate accessories across all products; split into listed vs not-listed
 *   4. For products whose accessories ARE listed → set custom.cross_sells metafield
 *   5. Save full CSV of all found accessories (grizzly_accessories.csv)
 *   6. Email the NOT-YET-LISTED accessories as a CSV attachment
 *
 * Usage:
 *   node scrapeGrizzlyCrossSells.js [brand] [--dry-run] [--limit=N] [--after=SKU]
 *
 * Examples:
 *   node scrapeGrizzlyCrossSells.js
 *   node scrapeGrizzlyCrossSells.js "Shop Fox" --limit=50
 *   node scrapeGrizzlyCrossSells.js --dry-run
 *   node scrapeGrizzlyCrossSells.js --retry       (re-run only SKUs that failed last time)
 */

// ── Config ───────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2026-01'
const VENDORS = ['Grizzly', 'Shop Fox', 'South Bend']
const GRIZZLY_BASE = 'https://www.grizzly.com'

const BRAND_FILTER =
    process.argv.find((a) => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]) || null
const DRY_RUN = process.argv.includes('--dry-run')
const RETRY_MODE = process.argv.includes('--retry')
const LIMIT = parseInt((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || Infinity
const SCRAPE_DELAY_MS = 1500
const CONCURRENCY = 3

const CSV_OUT = new URL('./grizzly_accessories.csv', import.meta.url)
const RETRY_FILE = new URL('./grizzly_cross_sells_retry.json', import.meta.url)

const TO = 'gjarman@factorypure.com'
const FROM = 'gjarman@factorypure.com'

const GRIZZLY_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

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
            console.log(`  [RETRY] Shopify (attempt ${attempt}/${retries}): ${err.message}, retrying in ${delay}ms...`)
            await new Promise((r) => setTimeout(r, delay))
        }
    }
}

// ── Scraping ─────────────────────────────────────────────────────────────────
async function fetchGrizzlyPage(url, retries = 5) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        let res
        try {
            res = await fetch(url, {
                headers: { 'User-Agent': GRIZZLY_UA },
                signal: AbortSignal.timeout(20000),
                redirect: 'follow',
            })
        } catch (err) {
            if (attempt < retries) {
                const wait = attempt * 3000
                console.warn(
                    `  [fetch] Network error (attempt ${attempt}/${retries}), retrying in ${wait / 1000}s: ${err.message}`
                )
                await new Promise((r) => setTimeout(r, wait))
                continue
            }
            throw err
        }
        if (res.status === 429 || res.status === 503) {
            const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10)
            const wait = retryAfter > 0 ? retryAfter * 1000 : attempt * 5000
            console.warn(
                `  [fetch] Rate limited (${res.status}) (attempt ${attempt}/${retries}), waiting ${wait / 1000}s...`
            )
            await new Promise((r) => setTimeout(r, wait))
            continue
        }
        if (!res.ok) return res

        // Read the body and check for window.product — Grizzly sometimes silently
        // returns a 200 bot-check/empty page with no product JSON when rate limiting
        const html = await res.text()
        if (!html.includes('window.product=')) {
            if (attempt < retries) {
                const wait = attempt * 6000
                console.warn(
                    `  [fetch] Got 200 but no window.product for ${url} (attempt ${attempt}/${retries}), waiting ${wait / 1000}s...`
                )
                await new Promise((r) => setTimeout(r, wait))
                continue
            }
            // Attach the html so callers can inspect it without re-fetching
            res._html = html
            res._blocked = true
            return res
        }

        res._html = html
        return res
    }
    throw new Error(`Exhausted retries for ${url}`)
}

/**
 * Returns array of { sku, name } from window.product.Accessories for the given product SKU.
 */
// Returns array of { sku, name }, or null if the page was silently blocked
async function scrapeAccessories(sku) {
    const url = `${GRIZZLY_BASE}/products/x/${sku.toLowerCase()}`
    const res = await fetchGrizzlyPage(url)
    if (!res.ok) return null
    // fetchGrizzlyPage pre-reads and caches html on res._html (after verifying window.product exists)
    const html = res._html
    if (!html || res._blocked) return null
    const m = html.match(/window\.product=(\{[\s\S]*?\});(?:window\.|<\/script>)/)
    if (!m) return []
    let product
    try {
        product = JSON.parse(m[1])
    } catch {
        return []
    }
    // Merge Accessories + KitComponents — both represent items shown alongside the product
    const accessories = (product.Accessories || [])
        .filter((a) => a.Sku)
        .map((a) => ({ sku: a.Sku.trim(), name: a.Name || '' }))
    const kitComponents = (product.KitComponents || [])
        .filter((a) => a.Sku)
        .map((a) => ({ sku: a.Sku.trim(), name: a.Name || a.Sku || '' }))
    const combined = [...accessories]
    for (const item of kitComponents) {
        if (!combined.some((a) => a.sku.toUpperCase() === item.sku.toUpperCase())) combined.push(item)
    }
    return combined
}

// ── CSV / Email ───────────────────────────────────────────────────────────────
function escapeCsv(val) {
    return `"${String(val ?? '').replace(/"/g, '""')}"`
}

function buildCsv(rows) {
    const header = 'accessory_sku,accessory_name,listed,found_on_skus,found_on_count'
    const lines = rows.map((r) =>
        [
            escapeCsv(r.accessorySku),
            escapeCsv(r.accessoryName),
            r.listed ? 'yes' : 'no',
            escapeCsv(r.foundOnSkus.join(', ')),
            r.foundOnSkus.length,
        ].join(',')
    )
    return [header, ...lines].join('\r\n')
}

async function sendEmail(subject, bodyText, csvContent, csvName) {
    const base64Csv = Buffer.from(csvContent).toString('base64')
    const boundary = '----boundary_' + Date.now().toString(16)
    const rawMessage = [
        `From: ${FROM}`,
        `To: ${TO}`,
        `Subject: ${subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset=UTF-8`,
        ``,
        bodyText,
        ``,
        `--${boundary}`,
        `Content-Type: text/csv; name="${csvName}"`,
        `Content-Disposition: attachment; filename="${csvName}"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        base64Csv,
        ``,
        `--${boundary}--`,
    ].join('\r\n')

    const ses = new SESClient({ region: 'us-east-2' })
    await ses.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(rawMessage) } }))
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const pool = createPool()

    try {
        console.log(`\n═══ Grizzly Cross-Sells Scraper ═══`)
        console.log(`Brand Filter: ${BRAND_FILTER || 'ALL (Grizzly, Shop Fox, South Bend)'}`)
        console.log(`Dry Run: ${DRY_RUN}`)
        console.log(`Limit: ${LIMIT === Infinity ? 'none' : LIMIT}\n`)

        // 1. Get store info
        const [storeInfo] = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)

        // 2. Fetch all listed Grizzly-family products from DB
        // Use LIKE to catch vendor variants: 'Grizzly', 'Grizzly PRO', 'Grizzly Precision', etc.
        const vendorConditions = BRAND_FILTER
            ? `p.vendor = ?`
            : `(p.vendor LIKE 'Grizzly%' OR p.vendor = 'Shop Fox' OR p.vendor = 'South Bend')`
        const vendorArgs = BRAND_FILTER ? [BRAND_FILTER] : []

        const products = await query(
            pool,
            `SELECT p.id, p.title, p.product_type, p.admin_graphql_api_id, vn.sku
             FROM products p
             JOIN variants_new vn ON vn.product_id = p.id
             WHERE ${vendorConditions} AND p.store_id = ? AND vn.sku IS NOT NULL
             ORDER BY p.id`,
            [...vendorArgs, STORE_ID]
        )
        console.log(`Found ${products.length} listed product(s)`)
        if (products.length === 0) {
            console.log('Nothing to process. Exiting.')
            return
        }

        // 3. Build SKU → GID lookup across ALL products in the store (any vendor)
        //    so we correctly detect listed status even for variant vendor names like 'Grizzly PRO'
        const allRows = await query(
            pool,
            `SELECT p.id, p.admin_graphql_api_id, vn.sku
             FROM products p
             JOIN variants_new vn ON vn.product_id = p.id
             WHERE p.store_id = ? AND vn.sku IS NOT NULL`,
            [STORE_ID]
        )
        const skuToGid = new Map()
        for (const r of allRows) {
            skuToGid.set(r.sku.trim().toUpperCase(), r.admin_graphql_api_id || `gid://shopify/Product/${r.id}`)
        }
        console.log(`Built SKU→GID map for ${skuToGid.size} listed product(s)\n`)

        // 4. Determine which products to process
        // Exclude accessory/cross-sell SKUs (tagged grizzly_special_pricing) — they are
        // accessories themselves and don't need their own cross-sells scraped.
        const crossSellsPath = new URL('./grizzly_unlisted_cross_sells.csv', import.meta.url)
        const crossSellSkuSet = new Set()
        if (fs.existsSync(crossSellsPath)) {
            const lines = fs.readFileSync(crossSellsPath, 'utf-8').split('\n')
            // Header: accessory_sku,accessory_name,listed,found_on_skus,found_on_count
            for (let i = 1; i < lines.length; i++) {
                const sku = lines[i].split(',')[0]?.trim().replace(/^"|"$/g, '')
                if (sku) crossSellSkuSet.add(sku.toUpperCase())
            }
            console.log(`Excluding ${crossSellSkuSet.size} cross-sell/accessory SKU(s) from scrape\n`)
        }

        let toProcess = products.filter((p) => !crossSellSkuSet.has(p.sku?.toUpperCase()))
        if (RETRY_MODE) {
            let retrySkus = []
            try {
                retrySkus = JSON.parse(fs.readFileSync(RETRY_FILE, 'utf-8'))
            } catch {
                console.log('No retry file found. Nothing to retry.')
                return
            }
            const retrySet = new Set(retrySkus.map((s) => s.toUpperCase()))
            toProcess = products.filter((p) => retrySet.has(p.sku.toUpperCase()))
            console.log(
                `Retrying ${toProcess.length} previously failed SKU(s) from ${retrySkus.length} in retry file\n`
            )
        }
        toProcess = toProcess.slice(0, LIMIT)
        console.log(`Scraping accessories for ${toProcess.length} product(s)...\n`)

        // accessoryMap: accessory SKU (uppercase) → { accessoryName, foundOnSkus: Set }
        const accessoryMap = new Map()
        // cross-sell updates to apply after scraping
        const crossSellUpdates = []
        // SKUs that failed (errors or silent blocks) — saved to retry file at end
        const failedSkus = []
        let scrapeSuccess = 0,
            scrapeFail = 0

        for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
            const batch = toProcess.slice(i, i + CONCURRENCY)

            await Promise.allSettled(
                batch.map(async (product) => {
                    const { sku, title, id, admin_graphql_api_id } = product
                    try {
                        const accessories = await scrapeAccessories(sku)

                        if (accessories === null) {
                            console.warn(`  [${sku}] ✗ Blocked or failed to load page — queued for retry`)
                            failedSkus.push(sku)
                            scrapeFail++
                            return
                        }

                        if (accessories.length === 0) {
                            console.log(`  [${sku}] No accessories`)
                            scrapeSuccess++
                            return
                        }

                        for (const { sku: accSku, name: accName } of accessories) {
                            const key = accSku.toUpperCase()
                            if (!accessoryMap.has(key)) {
                                accessoryMap.set(key, { accessoryName: accName, foundOnSkus: new Set() })
                            }
                            accessoryMap.get(key).foundOnSkus.add(sku)
                        }

                        const listedGids = [
                            ...new Set(accessories.map((a) => skuToGid.get(a.sku.toUpperCase())).filter(Boolean)),
                        ]

                        console.log(
                            `  [${sku}] ${accessories.length} accessory(s): ${listedGids.length} listed, ${accessories.length - listedGids.length} not listed`
                        )

                        if (listedGids.length > 0) {
                            crossSellUpdates.push({
                                sku,
                                title,
                                productGid: admin_graphql_api_id || `gid://shopify/Product/${id}`,
                                gids: listedGids,
                            })
                        }

                        scrapeSuccess++
                    } catch (err) {
                        console.error(`  [${sku}] ✗ ${err.message} — queued for retry`)
                        failedSkus.push(sku)
                        scrapeFail++
                    }
                })
            )

            if (SCRAPE_DELAY_MS > 0 && i + CONCURRENCY < toProcess.length) {
                await new Promise((r) => setTimeout(r, SCRAPE_DELAY_MS))
            }
        }

        // 5. Build and save full CSV (all accessories, unlisted first)
        const csvRows = []
        for (const [key, { accessoryName, foundOnSkus }] of accessoryMap) {
            csvRows.push({
                accessorySku: key,
                accessoryName,
                listed: skuToGid.has(key),
                foundOnSkus: [...foundOnSkus],
            })
        }
        csvRows.sort((a, b) => (a.listed === b.listed ? 0 : a.listed ? 1 : -1))

        const csvContent = buildCsv(csvRows)
        fs.writeFileSync(CSV_OUT, csvContent)

        const notListedRows = csvRows.filter((r) => !r.listed)
        const listedRows = csvRows.filter((r) => r.listed)
        console.log(`\nSaved ${csvRows.length} accessory row(s) to grizzly_accessories.csv`)
        console.log(`  ${notListedRows.length} not yet listed  |  ${listedRows.length} already listed`)

        // Save or clear retry file
        if (failedSkus.length > 0) {
            fs.writeFileSync(RETRY_FILE, JSON.stringify(failedSkus, null, 2))
            console.log(
                `\n  Saved ${failedSkus.length} failed SKU(s) to grizzly_cross_sells_retry.json — run with --retry to retry them`
            )
        } else if (RETRY_MODE) {
            // All retries succeeded — clear the file
            try {
                fs.unlinkSync(RETRY_FILE)
            } catch {
                /* already gone */
            }
            console.log(`\n  All retried SKUs succeeded — retry file cleared`)
        }

        // 6. Set cross_sells metafield for products with listed accessories
        if (!DRY_RUN && crossSellUpdates.length > 0) {
            console.log(`\nUpdating cross_sells metafield for ${crossSellUpdates.length} product(s)...`)
            let metaSuccess = 0,
                metaFail = 0
            for (const update of crossSellUpdates) {
                try {
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
                                    ownerId: update.productGid,
                                    namespace: 'custom',
                                    key: 'cross_sells',
                                    type: 'list.product_reference',
                                    value: JSON.stringify(update.gids),
                                },
                            ],
                        }
                    )
                    const errors = result.data?.metafieldsSet?.userErrors
                    if (errors?.length) {
                        console.error(`  [${update.sku}] Shopify error:`, errors)
                        metaFail++
                    } else {
                        console.log(`  [${update.sku}] ✓ cross_sells set (${update.gids.length} item(s))`)
                        metaSuccess++
                    }
                } catch (err) {
                    console.error(`  [${update.sku}] ✗ ${err.message}`)
                    metaFail++
                }
            }
            console.log(`  Metafield updates: ${metaSuccess} ✓  ${metaFail} ✗`)
        } else if (DRY_RUN && crossSellUpdates.length > 0) {
            console.log(`\n[DRY RUN] Would set cross_sells for ${crossSellUpdates.length} product(s)`)
        }

        // 7. Email the not-yet-listed accessories
        if (!DRY_RUN && notListedRows.length > 0) {
            console.log(`\nEmailing ${notListedRows.length} not-listed accessory SKU(s) to ${TO}...`)
            const notListedCsv = buildCsv(notListedRows)
            const subject = `Grizzly Accessories to List — ${notListedRows.length} SKU(s) (${new Date().toLocaleDateString()})`
            const body =
                `Found ${notListedRows.length} accessory SKU(s) referenced on Grizzly product pages that are not yet listed in our store.\n\n` +
                `These are cross-sells on products we carry. Consider listing them (price can be adjusted to hit margin later).\n\n` +
                `grizzly_accessories.csv (all ${csvRows.length} accessories, listed + unlisted) has also been saved locally.`
            try {
                await sendEmail(subject, body, notListedCsv, 'grizzly_not_listed_accessories.csv')
                console.log('  ✓ Email sent')
            } catch (err) {
                console.error('  ✗ Email failed:', err.message)
            }
        }

        console.log(`\n── Summary ──────────────────────────────`)
        console.log(`  Pages scraped:      ${scrapeSuccess} ✓  ${scrapeFail} ✗`)
        console.log(`  Unique accessories: ${csvRows.length} total (${notListedRows.length} not listed)`)
        console.log(`  Cross-sell updates: ${crossSellUpdates.length} product(s) with listed accessories`)
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
