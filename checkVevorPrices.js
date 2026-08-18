/**
 * checkVevorPrices.js
 *
 * 1. Downloads the Vevor feed
 * 2. Builds a SKU → feed price map
 * 3. Paginates all Vevor products from Shopify and collects variant SKU + price
 * 4. Compares prices and collects differences
 * 5. Emails a CSV of differences (SKU, Our Price, Feed Price) to gjarman@factorypure.com
 *
 * Usage:
 *   node checkVevorPrices.js           # live run
 *   node checkVevorPrices.js --dry-run # print differences, no email
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import xlsx from 'xlsx'
import mysql from 'mysql'
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'

// ── Config ──────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2026-01'
const DRY_RUN = process.argv.includes('--dry-run')

const VEVOR_ENDPOINT = process.env.VEVOR_ENDPOINT
const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

const TO = 'gjarman@factorypure.com'
const FROM = 'gjarman@factorypure.com'

// ── DB (credentials only) ────────────────────────────────────────────────────
function dbQuery(sql, args = []) {
    const pool = mysql.createPool({
        connectionLimit: 1,
        host: DB_WRITE_HOST,
        user: DB_USER,
        password: DB_PASSWORD,
        port: 3306,
        database: 'main',
        timezone: '+00:00',
    })
    return new Promise((resolve, reject) => {
        pool.query(sql, args, (err, results) => {
            pool.end()
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

// Paginate all Vevor products and return an array of { sku, price } for every variant
async function fetchAllVevorVariants(storeInfo) {
    const variants = []
    let cursor = null
    let page = 0

    do {
        page++
        const data = await shopifyGraphQL(
            storeInfo,
            `query getVevorProducts($cursor: String) {
                products(first: 250, after: $cursor, query: "vendor:Vevor") {
                    pageInfo { hasNextPage }
                    edges {
                        cursor
                        node {
                            variants(first: 100) {
                                nodes {
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
                const price = parseFloat(v.price)
                if (sku && !isNaN(price)) {
                    variants.push({ sku, price })
                }
            }
        }

        const hasNextPage = data.products.pageInfo.hasNextPage
        cursor = hasNextPage ? edges[edges.length - 1].cursor : null
        console.log(`  Shopify page ${page}: fetched ${edges.length} products (${variants.length} variants total)`)
    } while (cursor)

    return variants
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    console.log(`\n═══ Check Vevor Prices ═══`)
    console.log(`Dry Run: ${DRY_RUN}\n`)

    // 1. Get store credentials
    const [storeInfo] = await dbQuery(`SELECT shopify_name, access_token FROM stores WHERE id = ?`, [STORE_ID])
    if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)

    // 2. Download Vevor feed
    console.log('Fetching Vevor feed...')
    const res = await fetch(VEVOR_ENDPOINT)
    const buffer = await res.arrayBuffer()
    const workbook = xlsx.read(Buffer.from(buffer))
    const feedRows = xlsx.utils.sheet_to_json(workbook.Sheets.feed)
    console.log(`Feed has ${feedRows.length} rows`)

    // 3. Build SKU → feed price map (take first occurrence per SKU)
    const feedPriceMap = new Map()
    for (const row of feedRows) {
        const sku = (row['SKU'] || '').trim()
        if (!sku || feedPriceMap.has(sku)) continue
        const raw = (row['Price'] || '').toString().replace(/[^0-9.]/g, '')
        const price = parseFloat(raw)
        if (!isNaN(price)) feedPriceMap.set(sku, price)
    }
    console.log(`Feed has ${feedPriceMap.size} distinct SKUs with prices\n`)

    // 4. Fetch all Vevor variants from Shopify
    console.log('Fetching Vevor variants from Shopify...')
    const shopifyVariants = await fetchAllVevorVariants(storeInfo)
    console.log(`\nFetched ${shopifyVariants.length} Vevor variant(s) from Shopify\n`)

    if (shopifyVariants.length === 0) {
        console.log('No Vevor variants found in Shopify. Exiting.')
        return
    }

    // 5. Compare prices
    const differences = []
    for (const { sku, price: ourPrice } of shopifyVariants) {
        if (!feedPriceMap.has(sku)) continue
        const feedPrice = feedPriceMap.get(sku)
        if (Math.abs(ourPrice - feedPrice) > 0.01) {
            differences.push({ SKU: sku, 'Our Price': ourPrice.toFixed(2), 'Feed Price': feedPrice.toFixed(2) })
        }
    }

    console.log(`Found ${differences.length} price difference(s)`)

    if (differences.length === 0) {
        console.log('All prices match. Nothing to email.')
        return
    }

    // 6. Preview
    const preview = differences.slice(0, 10)
    for (const d of preview) {
        console.log(`  • SKU: ${d.SKU}  Our: $${d['Our Price']}  Feed: $${d['Feed Price']}`)
    }
    if (differences.length > 10) {
        console.log(`  ... and ${differences.length - 10} more`)
    }

    if (DRY_RUN) {
        console.log(`\n[DRY RUN] Would email ${differences.length} difference(s)`)
        return
    }

    // 7. Build CSV and email
    const csvRows = ['SKU,Our Price,Feed Price']
    for (const d of differences) {
        csvRows.push(`"${d.SKU}",${d['Our Price']},${d['Feed Price']}`)
    }
    const csvContent = csvRows.join('\r\n')
    const csvBase64 = Buffer.from(csvContent).toString('base64')

    const subject = `Vevor Price Check — ${differences.length} difference(s) found`
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
        `Found ${differences.length} Vevor SKU(s) where our Shopify price differs from the current feed price.`,
        ``,
        `Attached CSV includes: SKU, Our Price, Feed Price.`,
        ``,
        `--${boundary}`,
        `Content-Type: text/csv; name="vevor_price_differences.csv"`,
        `Content-Disposition: attachment; filename="vevor_price_differences.csv"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        csvBase64,
        ``,
        `--${boundary}--`,
    ].join('\r\n')

    const ses = new SESClient({ region: 'us-east-2' })
    await ses.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(rawMessage) } }))

    console.log(`\n═══ Done ═══`)
    console.log(`Email sent to ${TO} with ${differences.length} difference(s)`)
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
