/**
 * fixCostwayVariantSkus.js
 *
 * For each Costway variant in the DB, looks up its SKU in the feed's "Item No"
 * column. If found, updates the variant's SKU and custom.supplier_sku metafield
 * with the feed's "Variant SKU" value.
 *
 * Usage:
 *   node fixCostwayVariantSkus.js           # downloads fresh feed
 *   node fixCostwayVariantSkus.js --cached  # reuse costway_data/feed_cache.csv
 *   node fixCostwayVariantSkus.js --dry-run # preview changes, no writes
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fs from 'fs'
import { createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import fetch from 'node-fetch'
import { parse } from 'csv-parse/sync'
import mysql from 'mysql'

// ── Config ──────────────────────────────────────────────────────────────────
const FEED_URL = 'https://www.costway.com/media/feed/US-Dropship-Shopify.csv'
const FEED_CACHE_PATH = './costway_data/feed_cache.csv'
const MIN_FEED_BYTES = 50 * 1024 * 1024
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2026-01'
const CONCURRENCY = 5

const USE_CACHE = process.argv.includes('--cached')
const DRY_RUN = process.argv.includes('--dry-run')

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

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

function endPool(pool) {
    return new Promise((resolve) => pool.end(resolve))
}

// ── Feed ────────────────────────────────────────────────────────────────────
async function downloadFeed() {
    console.log(`Downloading feed from ${FEED_URL} ...`)
    const feedRes = await fetch(FEED_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!feedRes.ok) throw new Error(`Feed download failed: ${feedRes.status}`)

    if (!fs.existsSync('./costway_data')) fs.mkdirSync('./costway_data', { recursive: true })

    const tempFile = `${FEED_CACHE_PATH}.tmp`
    await pipeline(feedRes.body, createWriteStream(tempFile))

    const bytes = fs.statSync(tempFile).size
    if (bytes < MIN_FEED_BYTES) {
        fs.unlinkSync(tempFile)
        throw new Error(`Downloaded feed too small (${bytes} bytes), aborting`)
    }

    fs.renameSync(tempFile, FEED_CACHE_PATH)
    console.log(`Feed saved to ${FEED_CACHE_PATH} (${Math.round(bytes / 1024 / 1024)} MB)`)
}

// ── Shopify ──────────────────────────────────────────────────────────────────
async function shopifyGraphQL(storeInfo, queryStr, variables) {
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
    return res.json()
}

async function updateVariantSku({ storeInfo, productGid, variantGid, newSku }) {
    const res = await shopifyGraphQL(
        storeInfo,
        `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                productVariants {
                    id
                    sku
                }
                userErrors { field message }
            }
        }`,
        {
            productId: productGid,
            variants: [
                {
                    id: variantGid,
                    inventoryItem: { sku: newSku },
                    metafields: [
                        {
                            namespace: 'custom',
                            key: 'supplier_sku',
                            value: newSku,
                            type: 'single_line_text_field',
                        },
                    ],
                },
            ],
        }
    )
    if (res.errors) throw new Error(`GraphQL errors: ${JSON.stringify(res.errors)}`)
    const userErrors = res.data?.productVariantsBulkUpdate?.userErrors || []
    if (userErrors.length > 0) throw new Error(`userErrors: ${JSON.stringify(userErrors)}`)
    return res.data.productVariantsBulkUpdate.productVariants
}

// ── Concurrency helper ───────────────────────────────────────────────────────
async function runWithConcurrency(tasks, limit) {
    const results = []
    const executing = new Set()
    for (const task of tasks) {
        const p = task().then((r) => { executing.delete(p); return r })
        executing.add(p)
        results.push(p)
        if (executing.size >= limit) await Promise.race(executing)
    }
    return Promise.all(results)
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    if (DRY_RUN) console.log('[DRY RUN] No writes will be made.\n')

    // 1. Get the feed
    if (USE_CACHE) {
        if (!fs.existsSync(FEED_CACHE_PATH)) {
            throw new Error(`--cached used but ${FEED_CACHE_PATH} not found. Run without --cached first.`)
        }
        console.log(`Using cached feed: ${FEED_CACHE_PATH}`)
    } else {
        await downloadFeed()
    }

    // 2. Parse feed — build Item No → Variant SKU map
    console.log('Parsing feed CSV...')
    const feedCsv = fs.readFileSync(FEED_CACHE_PATH, 'utf-8')
    const rows = parse(feedCsv, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        relax_quotes: true,
        bom: true,
    })
    console.log(`Feed rows: ${rows.length}`)

    const feedByItemNo = new Map() // Item No → first matching row
    for (const row of rows) {
        const itemNo = (row['Item No'] || '').trim()
        if (!itemNo) continue
        if (!feedByItemNo.has(itemNo)) feedByItemNo.set(itemNo, row)
    }
    console.log(`Unique Item Nos in feed: ${feedByItemNo.size}`)

    // 3. Query DB for Costway variants
    const pool = createPool()
    try {
        const storeRows = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeRows.length) throw new Error(`Store ${STORE_ID} not found`)
        const storeInfo = storeRows[0]

        console.log('Querying DB for Costway variants...')
        const dbVariants = await query(
            pool,
            `SELECT vn.id, vn.sku, p.id AS product_id
             FROM variants_new vn
             JOIN products p ON p.id = vn.product_id
             WHERE p.vendor = 'Costway'
               AND vn.sku IS NOT NULL
               AND vn.sku != ''
               AND p.store_id = ?`,
            [STORE_ID]
        )
        console.log(`DB Costway variants: ${dbVariants.length}`)

        // 4. Find variants that have a feed match and need updating
        const toUpdate = []
        for (const variant of dbVariants) {
            const feedRow = feedByItemNo.get(variant.sku.trim())
            if (!feedRow) continue
            const feedVariantSku = (feedRow['Variant SKU'] || '').trim()
            if (!feedVariantSku || feedVariantSku === variant.sku.trim()) continue
            toUpdate.push({ variant, feedVariantSku })
        }
        console.log(`Variants to update: ${toUpdate.length}`)

        if (toUpdate.length === 0) {
            console.log('Nothing to update.')
            return
        }

        // 5. Update each variant
        let updated = 0
        let failed = 0

        const tasks = toUpdate.map(({ variant, feedVariantSku }) => async () => {
            const variantGid = `gid://shopify/ProductVariant/${variant.id}`
            const productGid = `gid://shopify/Product/${variant.product_id}`
            const oldSku = variant.sku.trim()

            if (DRY_RUN) {
                console.log(`[DRY RUN] variant ${variant.id}: ${oldSku} → ${feedVariantSku}`)
                return
            }

            try {
                await updateVariantSku({ storeInfo, productGid, variantGid, newSku: feedVariantSku })

                await query(
                    pool,
                    `UPDATE variants_new SET sku = ?, custom_supplier_sku = ? WHERE id = ? AND store_id = ?`,
                    [feedVariantSku, feedVariantSku, variant.id, STORE_ID]
                )

                console.log(`✓ variant ${variant.id}: ${oldSku} → ${feedVariantSku}`)
                updated++
            } catch (err) {
                console.error(`✗ variant ${variant.id} (${oldSku}): ${err.message}`)
                failed++
            }
        })

        await runWithConcurrency(tasks, CONCURRENCY)

        console.log(`\nDone. Updated: ${updated}, Failed: ${failed}`)
    } finally {
        await endPool(pool)
    }
}

main().catch((err) => {
    console.error('Fatal:', err.message)
    process.exit(1)
})
