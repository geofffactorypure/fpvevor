/**
 * checkVevorMarkPrices.js
 *
 * 1. Fetches all listed Vevor product SKUs from Shopify (paginated)
 * 2. Queries the Vevor skuprice API in batches of 50
 * 3. Collects SKUs where markPrice > shopPrice
 * 4. Emails a CSV of results (SKU, markPrice, shopPrice) to gjarman@factorypure.com
 *
 * Usage:
 *   node checkVevorMarkPrices.js           # live run
 *   node checkVevorMarkPrices.js --dry-run # print results, no email
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import xlsx from 'xlsx'
import mysql from 'mysql'
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'

// ── Config ───────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2026-01'
const VEVOR_BATCH_API = 'https://www.vevor.com/api/skuprice'
const VEVOR_MAP_FEED = 'https://ads-feed.s3.us-west-2.amazonaws.com/ads/business/553/vevor-553.xlsx'
const BATCH_SIZE = 50
const DRY_RUN = process.argv.includes('--dry-run')

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

const TO = 'gjarman@factorypure.com'
const FROM = 'gjarman@factorypure.com'

// ── DB ────────────────────────────────────────────────────────────────────────
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

// ── Shopify ───────────────────────────────────────────────────────────────────
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

async function fetchAllVevorSkus(storeInfo) {
    const skus = []
    let cursor = null
    let page = 0

    do {
        page++
        const data = await shopifyGraphQL(
            storeInfo,
            `query getVevorProducts($cursor: String) {
                products(first: 250, after: $cursor, query: "vendor:Vevor status:active") {
                    pageInfo { hasNextPage }
                    edges {
                        cursor
                        node {
                            variants(first: 100) {
                                nodes {
                                    sku
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
                if (sku) skus.push(sku)
            }
        }

        const hasNextPage = data.products.pageInfo.hasNextPage
        cursor = hasNextPage ? edges[edges.length - 1].cursor : null
        console.log(`  Shopify page ${page}: fetched ${edges.length} products (${skus.length} SKUs total)`)
    } while (cursor)

    return [...new Set(skus)]
}

// ── Vevor skuprice API ────────────────────────────────────────────────────────
async function fetchVevorSkuBatch(skus, retries = 3, backoff = 2000) {
    let attempts = 0
    while (attempts < retries) {
        try {
            const response = await fetch(VEVOR_BATCH_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ skuList: skus }),
            })
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`)
            }
            const result = await response.json()
            if (!result || result.msg !== 'SUCCESS') {
                throw new Error(`Unexpected response: ${JSON.stringify(result)}`)
            }
            return result
        } catch (err) {
            attempts++
            console.warn(`  Attempt ${attempts} failed for batch: ${err.message}`)
            if (attempts >= retries) {
                throw new Error(`Failed to fetch Vevor SKU batch after ${attempts} attempts`)
            }
            await new Promise((resolve) => setTimeout(resolve, backoff * attempts))
        }
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log(`\n═══ Check Vevor Mark Prices ═══`)
    console.log(`Dry Run: ${DRY_RUN}\n`)

    // 1. Get store credentials
    const [storeInfo] = await dbQuery(`SELECT shopify_name, access_token FROM stores WHERE id = ?`, [STORE_ID])
    if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)

    // 2. Fetch all active Vevor SKUs from Shopify
    console.log('Fetching active Vevor SKUs from Shopify...')
    const allSkus = await fetchAllVevorSkus(storeInfo)
    console.log(`\nFound ${allSkus.length} unique Vevor SKU(s)\n`)

    if (allSkus.length === 0) {
        console.log('No Vevor SKUs found. Exiting.')
        return
    }

    // 3. Query skuprice API in batches of 50, storing all raw data
    console.log(`Querying Vevor skuprice API in batches of ${BATCH_SIZE}...`)
    const skuDataMap = {}
    const markPriceResults = []
    const totalBatches = Math.ceil(allSkus.length / BATCH_SIZE)

    for (let i = 0; i < allSkus.length; i += BATCH_SIZE) {
        const batch = allSkus.slice(i, i + BATCH_SIZE)
        const batchNum = Math.floor(i / BATCH_SIZE) + 1
        process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch.length} SKUs)...`)

        const batchData = await fetchVevorSkuBatch(batch).catch((err) => {
            console.warn(` FAILED: ${err.message}`)
            return null
        })

        if (!batchData?.data) {
            console.log(' no data')
            continue
        }

        let found = 0
        for (const [sku, skuInfo] of Object.entries(batchData.data)) {
            const markPrice = parseFloat(skuInfo.markPrice)
            const shopPrice = parseFloat(skuInfo.shopPrice)
            const promotionPrice =
                skuInfo.promotionPrice != null && skuInfo.promotionPrice !== ''
                    ? parseFloat(skuInfo.promotionPrice)
                    : null

            skuDataMap[sku] = { markPrice, shopPrice, promotionPrice }

            if (
                promotionPrice != null &&
                !isNaN(promotionPrice) &&
                !isNaN(markPrice) &&
                !isNaN(shopPrice) &&
                markPrice > shopPrice
            ) {
                markPriceResults.push({
                    SKU: sku,
                    markPrice: markPrice.toFixed(2),
                    shopPrice: shopPrice.toFixed(2),
                    difference: (markPrice - shopPrice).toFixed(2),
                    promotionPrice: promotionPrice.toFixed(2),
                })
                found++
            }
        }
        console.log(` done (${found} markPrice > shopPrice)`)
    }

    console.log(`\nFound ${markPriceResults.length} SKU(s) where promotionPrice present and markPrice > shopPrice`)
    const markPreview = markPriceResults.slice(0, 5)
    for (const r of markPreview) {
        console.log(
            `  • SKU: ${r.SKU}  markPrice: $${r.markPrice}  shopPrice: $${r.shopPrice}  diff: $${r.difference}  promotionPrice: $${r.promotionPrice}`
        )
    }
    if (markPriceResults.length > 5) console.log(`  ... and ${markPriceResults.length - 5} more`)

    // 4. Download MAP feed and compare calculated list price
    console.log(`\nFetching MAP feed...`)
    const mapRes = await fetch(VEVOR_MAP_FEED)
    const mapBuf = Buffer.from(await mapRes.arrayBuffer())
    const wb = xlsx.read(mapBuf)
    const feedRows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]])

    // Build MAP price map: SKU -> mapPrice (strip 'USD' suffix)
    const mapPriceMap = {}
    for (const row of feedRows) {
        const sku = (row['SKU'] || '').trim()
        const raw = (row['MAP (Minimum Advertised Price)'] || '').toString().replace(/[^0-9.]/g, '')
        const mapPrice = parseFloat(raw)
        if (sku && !isNaN(mapPrice)) mapPriceMap[sku] = mapPrice
    }
    console.log(`Feed has ${Object.keys(mapPriceMap).length} SKUs with MAP prices`)

    // Compare: calculatedListPrice = markPrice if promotionPrice present, else shopPrice
    const mapMismatchResults = []
    const shopPriceMismatchResults = []
    for (const [sku, mapPrice] of Object.entries(mapPriceMap)) {
        const skuData = skuDataMap[sku]
        if (!skuData) continue
        const { markPrice, shopPrice, promotionPrice } = skuData
        const hasPromo = promotionPrice != null && !isNaN(promotionPrice)
        const calcListPrice = hasPromo ? markPrice : shopPrice
        if (!isNaN(calcListPrice) && Math.abs(calcListPrice - mapPrice) > 0.01) {
            mapMismatchResults.push({
                SKU: sku,
                calculatedListPrice: calcListPrice.toFixed(2),
                mapPrice: mapPrice.toFixed(2),
                difference: (calcListPrice - mapPrice).toFixed(2),
                priceSource: hasPromo ? 'markPrice' : 'shopPrice',
            })
        }
        if (!isNaN(shopPrice) && Math.abs(shopPrice - mapPrice) > 0.01) {
            shopPriceMismatchResults.push({
                SKU: sku,
                shopPrice: shopPrice.toFixed(2),
                mapPrice: mapPrice.toFixed(2),
                difference: (shopPrice - mapPrice).toFixed(2),
            })
        }
    }

    console.log(`\nFound ${mapMismatchResults.length} SKU(s) where calculated list price != MAP price`)
    const mapPreview = mapMismatchResults.slice(0, 5)
    for (const r of mapPreview) {
        console.log(
            `  • SKU: ${r.SKU}  calcListPrice: $${r.calculatedListPrice} (${r.priceSource})  MAP: $${r.mapPrice}  diff: $${r.difference}`
        )
    }
    if (mapMismatchResults.length > 5) console.log(`  ... and ${mapMismatchResults.length - 5} more`)

    console.log(`\nFound ${shopPriceMismatchResults.length} SKU(s) where shopPrice != MAP price`)
    const shopPreview = shopPriceMismatchResults.slice(0, 5)
    for (const r of shopPreview) {
        console.log(`  \u2022 SKU: ${r.SKU}  shopPrice: $${r.shopPrice}  MAP: $${r.mapPrice}  diff: $${r.difference}`)
    }
    if (shopPriceMismatchResults.length > 5) console.log(`  ... and ${shopPriceMismatchResults.length - 5} more`)

    if (DRY_RUN) {
        console.log(
            `\n[DRY RUN] Would email ${markPriceResults.length} mark price result(s), ${mapMismatchResults.length} calc-MAP mismatch(es), ${shopPriceMismatchResults.length} shopPrice-MAP mismatch(es)`
        )
        return
    }

    if (markPriceResults.length === 0 && mapMismatchResults.length === 0 && shopPriceMismatchResults.length === 0) {
        console.log('No issues found. Nothing to email.')
        return
    }

    // 5. Build CSVs and email via SES
    const csv1Rows = ['SKU,markPrice,shopPrice,difference,promotionPrice']
    for (const r of markPriceResults) {
        csv1Rows.push(`"${r.SKU}",${r.markPrice},${r.shopPrice},${r.difference},${r.promotionPrice}`)
    }
    const csv1Base64 = Buffer.from(csv1Rows.join('\r\n')).toString('base64')

    const csv2Rows = ['SKU,calculatedListPrice,mapPrice,difference,priceSource']
    for (const r of mapMismatchResults) {
        csv2Rows.push(`"${r.SKU}",${r.calculatedListPrice},${r.mapPrice},${r.difference},${r.priceSource}`)
    }
    const csv2Base64 = Buffer.from(csv2Rows.join('\r\n')).toString('base64')

    const csv3Rows = ['SKU,shopPrice,mapPrice,difference']
    for (const r of shopPriceMismatchResults) {
        csv3Rows.push(`"${r.SKU}",${r.shopPrice},${r.mapPrice},${r.difference}`)
    }
    const csv3Base64 = Buffer.from(csv3Rows.join('\r\n')).toString('base64')

    const subject = `Vevor Price Audit — ${markPriceResults.length} mark price issue(s), ${mapMismatchResults.length} calc-MAP mismatch(es), ${shopPriceMismatchResults.length} shopPrice-MAP mismatch(es)`
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
        `=== Mark Price Issues (${markPriceResults.length}) ===`,
        `SKUs where promotionPrice is set and markPrice > shopPrice.`,
        `Columns: SKU, markPrice, shopPrice, difference, promotionPrice.`,
        ``,
        `=== MAP Price Mismatches — Calculated List Price (${mapMismatchResults.length}) ===`,
        `SKUs where calculated list price (markPrice if promotionPrice, else shopPrice) != MAP price from feed.`,
        `Columns: SKU, calculatedListPrice, mapPrice, difference, priceSource.`,
        ``,
        `=== MAP Price Mismatches — shopPrice (${shopPriceMismatchResults.length}) ===`,
        `SKUs where shopPrice directly != MAP price from feed.`,
        `Columns: SKU, shopPrice, mapPrice, difference.`,
        ``,
        `--${boundary}`,
        `Content-Type: text/csv; name="vevor_mark_price_issues.csv"`,
        `Content-Disposition: attachment; filename="vevor_mark_price_issues.csv"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        csv1Base64,
        ``,
        `--${boundary}`,
        `Content-Type: text/csv; name="vevor_map_mismatches.csv"`,
        `Content-Disposition: attachment; filename="vevor_map_mismatches.csv"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        csv2Base64,
        ``,
        `--${boundary}`,
        `Content-Type: text/csv; name="vevor_shopprice_map_mismatches.csv"`,
        `Content-Disposition: attachment; filename="vevor_shopprice_map_mismatches.csv"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        csv3Base64,
        ``,
        `--${boundary}--`,
    ].join('\r\n')

    const ses = new SESClient({ region: 'us-east-2' })
    await ses.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(rawMessage) } }))

    console.log(`\n═══ Done ═══`)
    console.log(`Email sent to ${TO}`)
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
