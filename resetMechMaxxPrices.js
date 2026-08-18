/**
 * resetMechMaxxPrices.js
 *
 * Reads mechmaxx-price-reset.csv and applies list price + cost to all matching
 * MechMaxx variants in our Shopify store.
 *
 * CSV columns used:
 *   SKU                  – variant SKU
 *   Current Website Price – list price to set
 *   Dropship Pricing     – cost to set on inventory item
 *   Liftgate Fee         – used in margin calculation
 *
 * Pricing rules (applied to every row):
 *   1. Cost is always set from Dropship Pricing.
 *   2. If margin >= 8%  → use CSV list price as-is.
 *   3. If margin <  8%  → try price + $70.
 *        a. If price+70 gives margin >= 8% → use price+70.
 *        b. Otherwise → raise price until margin = 12%.
 *   Items raised by $70 or raised to 12% are emailed as a summary.
 *
 * margin = (price - cost - liftgate) / price
 *
 * Usage:
 *   node resetMechMaxxPrices.js            # live update
 *   node resetMechMaxxPrices.js --dry-run  # preview only
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fs from 'fs'
import fetch from 'node-fetch'
import { parse } from 'csv-parse/sync'
import mysql from 'mysql'
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'

// ── Config ───────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2026-01'
const VENDOR = 'MechMaxx'
const CSV_PATH = new URL('./mechmaxx-price-reset.csv', import.meta.url)
const DRY_RUN = process.argv.includes('--dry-run')
const CONCURRENCY = 5
const TO = 'gjarman@factorypure.com'
const FROM = 'gjarman@factorypure.com'

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

// Strip a single trailing color-code letter (e.g. 310002Y → 310002, 150135G → 150135)
function stripColorCode(sku) {
    return sku.replace(/[A-Za-z]$/, '')
}

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

// Returns Map<sku, { variantGid, productGid, currentPrice, productStatus }>
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
                            status
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
                    productStatus: edge.node.status,
                })
            }
        }

        const hasNextPage = data.products.pageInfo.hasNextPage
        cursor = hasNextPage ? edges[edges.length - 1].cursor : null
        console.log(`  [our store] page ${page}: ${edges.length} products (${variantMap.size} total variants)`)
    } while (cursor)

    return variantMap
}

async function activateProduct(storeInfo, productGid) {
    const data = await shopifyGraphQL(
        storeInfo,
        `mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
                userErrors { field message }
            }
        }`,
        { input: { id: productGid, status: 'ACTIVE' } }
    )
    const errors = data.productUpdate?.userErrors
    if (errors?.length > 0) throw new Error(`Product activate errors: ${JSON.stringify(errors)}`)
}

async function updateVariant({ storeInfo, productGid, variantGid, price, cost, customerShipping, shippingCharge }) {
    const metafields = []
    if (customerShipping !== undefined) {
        metafields.push({
            namespace: 'custom',
            key: 'customer_shipping_fee',
            value: String(customerShipping),
            type: 'number_decimal',
        })
    }
    if (shippingCharge !== undefined) {
        metafields.push({
            namespace: 'custom',
            key: 'shipping_fee',
            value: String(shippingCharge),
            type: 'number_decimal',
        })
    }
    const variantInput = {
        id: variantGid,
        price: String(price),
        ...(metafields.length ? { metafields } : {}),
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

// ── Find delivery profile by name ──────────────────────────────────────────
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

// ── Assign variant GIDs to a delivery profile ────────────────────────────────
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

// ── Parse price string like "$1,454.03" → 1454.03 ───────────────────────────
function parseMoney(str) {
    if (!str) return null
    const n = parseFloat(String(str).replace(/[^0-9.]/g, ''))
    return isNaN(n) ? null : n
}

// ── Margin = (price - cost - liftgate) / price ───────────────────────────────
function calcMargin(price, cost, liftgate) {
    if (!price) return 0
    return (price - cost - liftgate) / price
}

// ── Price to hit a target margin exactly ─────────────────────────────────────
// Solving: margin = (price - cost - liftgate) / price  →  price = (cost + liftgate) / (1 - margin)
function priceForMargin(cost, liftgate, targetMargin) {
    return (cost + liftgate) / (1 - targetMargin)
}

// ── Resolve final price per pricing rules ────────────────────────────────────
// Returns { finalPrice, adjustment } where adjustment is null | '+$70' | 'raised to 12%'
function resolvePrice(csvPrice, cost, liftgate) {
    const margin = calcMargin(csvPrice, cost, liftgate)
    if (margin >= 0.08) return { finalPrice: csvPrice, adjustment: null }

    // Try +$70
    const price70 = csvPrice + 70
    if (calcMargin(price70, cost, liftgate) >= 0.08) {
        return { finalPrice: price70, adjustment: '+$70' }
    }

    // Raise to 12%
    const price12 = priceForMargin(cost, liftgate, 0.12)
    return { finalPrice: Math.ceil(price12 * 100) / 100, adjustment: 'raised to 12%' }
}

// ── Email summary ─────────────────────────────────────────────────────────────
async function sendEmail(raised70, raised12) {
    const lines = []
    lines.push('MechMaxx price reset complete.\n')

    if (raised70.length) {
        lines.push(`── Raised by $70 (${raised70.length} item${raised70.length > 1 ? 's' : ''}) ──`)
        for (const r of raised70) {
            lines.push(
                `  [${r.sku}] ${r.description}  |  $${r.originalPrice.toFixed(2)} → $${r.price.toFixed(2)}  |  margin: ${(calcMargin(r.price, r.cost, r.liftgate) * 100).toFixed(1)}%`
            )
        }
        lines.push('')
    }

    if (raised12.length) {
        lines.push(`── Raised to 12% margin (${raised12.length} item${raised12.length > 1 ? 's' : ''}) ──`)
        for (const r of raised12) {
            lines.push(
                `  [${r.sku}] ${r.description}  |  $${r.originalPrice.toFixed(2)} → $${r.price.toFixed(2)}  |  margin: 12%`
            )
        }
        lines.push('')
    }

    const bodyText = lines.join('\n')
    const subject = `MechMaxx Price Reset – ${raised70.length + raised12.length} price(s) adjusted`

    const rawMessage = [
        `From: ${FROM}`,
        `To: ${TO}`,
        `Subject: ${subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=UTF-8`,
        ``,
        bodyText,
    ].join('\r\n')

    const ses = new SESClient({ region: 'us-east-2' })
    await ses.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(rawMessage) } }))
    console.log(`\nEmail sent to ${TO}`)
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n═══ Reset MechMaxx Prices ═══')
    console.log(`Dry Run: ${DRY_RUN}\n`)

    // 1. Load CSV
    if (!fs.existsSync(CSV_PATH)) throw new Error(`CSV not found: ${CSV_PATH}`)
    const rows = parse(fs.readFileSync(CSV_PATH, 'utf-8'), {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        bom: true,
    })

    const csvMap = new Map()
    for (const row of rows) {
        const rawSku = row['SKU']?.trim()
        const price = parseMoney(row['Current Website Price'])
        const cost = parseMoney(row['Dropship Pricing'])
        const liftgate = 80
        const description = row['Product Description']?.trim() ?? ''
        if (!rawSku || price === null || cost === null) {
            console.warn(`  Skipping row with missing data: ${JSON.stringify(row)}`)
            continue
        }
        // A SKU field like "110802/110802R/110802Y" means all three SKUs get the same pricing
        const skus = rawSku
            .split('/')
            .map((s) => s.trim())
            .filter(Boolean)
        const { finalPrice, adjustment } = resolvePrice(price, cost, liftgate)
        for (const sku of skus) {
            csvMap.set(sku, { price: finalPrice, originalPrice: price, cost, liftgate, adjustment, description })
        }
    }
    console.log(`Loaded ${csvMap.size} SKU(s) from mechmaxx-price-reset.csv\n`)

    const pool = createPool()

    try {
        // 2. Get store info
        const [storeInfo] = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)
        console.log(`Using store: ${storeInfo.shopify_name}`)

        // 3. Fetch all listed MechMaxx variants
        console.log('\nFetching listed variants from our Shopify store...')
        const variantMap = await fetchListedVariants(storeInfo)
        console.log(`\nFetched ${variantMap.size} total variant(s)\n`)

        // 4. Match SKUs — iterate our Shopify variants so color variants
        //    (e.g. 101201R) fall back to their base SKU (101201) in the CSV.
        const toUpdate = []
        const notInCsv = []

        for (const [sku, shopifyData] of variantMap) {
            const csvData = csvMap.get(sku) ?? csvMap.get(stripColorCode(sku))
            if (!csvData) {
                notInCsv.push(sku)
                continue
            }
            toUpdate.push({ sku, ...csvData, ...shopifyData })
        }

        console.log(`${toUpdate.length} SKU(s) matched`)
        if (notInCsv.length) {
            console.log(`${notInCsv.length} Shopify SKU(s) not found in CSV (skipped): ${notInCsv.join(', ')}`)
        }

        if (toUpdate.length === 0) {
            console.log('Nothing to update. Exiting.')
            return
        }

        const raised70 = toUpdate.filter((r) => r.adjustment === '+$70')
        const raised12 = toUpdate.filter((r) => r.adjustment === 'raised to 12%')

        if (DRY_RUN) {
            console.log('\n[DRY RUN] Planned updates:')
            for (const row of toUpdate) {
                const priceTag =
                    row.price !== row.currentPrice
                        ? `$${row.currentPrice.toFixed(2)} → $${row.price.toFixed(2)}`
                        : `$${row.price.toFixed(2)} (unchanged)`
                const adj = row.adjustment ? ` [${row.adjustment}]` : ''
                const margin = (calcMargin(row.price, row.cost, row.liftgate) * 100).toFixed(1)
                console.log(`  [${row.sku}] price=${priceTag} | cost=$${row.cost.toFixed(2)} | margin=${margin}%${adj}`)
            }
            console.log(`\n[DRY RUN] Would update ${toUpdate.length} variant(s).`)
            console.log(`  Raised +$70: ${raised70.length} | Raised to 12%: ${raised12.length}`)
            console.log('No changes made.')
            return
        }

        // 5. Apply updates with concurrency limit
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
                            customerShipping: row.adjustment === '+$70' ? 70 : undefined,
                            shippingCharge: row.liftgate,
                        })
                        const priceChanged = row.price !== row.currentPrice
                        const adj = row.adjustment ? ` [${row.adjustment}]` : ''
                        let activated = ''
                        if (row.productStatus === 'DRAFT') {
                            await activateProduct(storeInfo, row.productGid)
                            activated = ' [activated]'
                        }
                        if (priceChanged) {
                            console.log(
                                `  ✓ [${row.sku}] $${row.currentPrice.toFixed(2)} → $${row.price.toFixed(2)}${adj}${activated}`
                            )
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
        console.log(`  Raised +$70: ${raised70.length} | Raised to 12%: ${raised12.length}`)

        // 6. Assign +$70 variants to the carrier shipping profile
        const profileVariants = raised70.map((r) => r.variantGid)
        if (profileVariants.length) {
            console.log(`\nAssigning ${profileVariants.length} variant(s) to carrier delivery profile...`)
            const profileId = await fetchDeliveryProfileId(storeInfo, 'FactoryPure Shipping')
            if (!profileId) {
                console.warn(
                    '  Warning: delivery profile "FactoryPure Shipping" not found — skipping profile assignment'
                )
            } else {
                await assignVariantsToDeliveryProfile(storeInfo, profileId, profileVariants)
                console.log(`  ✓ Assigned to profile ${profileId}`)
            }
        }

        // 7. Email if any prices were adjusted
        if (raised70.length || raised12.length) {
            await sendEmail(raised70, raised12)
        }
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal:', err.message)
    process.exit(1)
})
