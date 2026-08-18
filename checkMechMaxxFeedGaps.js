/**
 * checkMechMaxxFeedGaps.js
 *
 * Compares listed MechMaxx variants in our Shopify store against
 * mechmaxx-price-reset.csv and reports any SKUs that are listed
 * but missing from the feed.
 *
 * Usage:
 *   node checkMechMaxxFeedGaps.js
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
const CSV_PATH = new URL('./mechmaxx-price-reset.csv', import.meta.url)

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

// Returns Map<sku, { productTitle, productStatus, price }>
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
                            title
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
                    productTitle: edge.node.title,
                    productStatus: edge.node.status,
                    price: parseFloat(v.price),
                })
            }
        }

        const hasNextPage = data.products.pageInfo.hasNextPage
        cursor = hasNextPage ? edges[edges.length - 1].cursor : null
        console.log(`  [our store] page ${page}: ${edges.length} products (${variantMap.size} total variants)`)
    } while (cursor)

    return variantMap
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n═══ Check MechMaxx Feed Gaps ═══\n')

    // 1. Load CSV feed SKUs (split on '/')
    if (!fs.existsSync(CSV_PATH)) throw new Error(`CSV not found: ${CSV_PATH}`)
    const rows = parse(fs.readFileSync(CSV_PATH, 'utf-8'), {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        bom: true,
    })

    const feedSkus = new Set()
    for (const row of rows) {
        const rawSku = row['SKU']?.trim()
        if (!rawSku) continue
        for (const sku of rawSku.split('/').map((s) => s.trim()).filter(Boolean)) {
            feedSkus.add(sku)
        }
    }
    console.log(`Feed SKUs (mechmaxx-price-reset.csv): ${feedSkus.size}\n`)

    const pool = createPool()

    try {
        const [storeInfo] = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)
        console.log(`Using store: ${storeInfo.shopify_name}\n`)

        console.log('Fetching listed variants from our Shopify store...')
        const variantMap = await fetchListedVariants(storeInfo)
        console.log(`\nTotal listed variants: ${variantMap.size}`)

        // 2. Find listed SKUs not in feed
        const missing = []
        for (const [sku, info] of variantMap) {
            if (!feedSkus.has(sku)) {
                missing.push({ sku, ...info })
            }
        }

        console.log(`\n── Listed variants NOT in feed: ${missing.length} ──`)
        if (missing.length === 0) {
            console.log('  All listed variants are covered by the feed.')
        } else {
            // Group by product title for readability
            const byProduct = new Map()
            for (const item of missing) {
                const key = item.productTitle
                if (!byProduct.has(key)) byProduct.set(key, [])
                byProduct.get(key).push(item)
            }
            for (const [title, items] of byProduct) {
                const statusTag = items[0].productStatus !== 'ACTIVE' ? ` [${items[0].productStatus}]` : ''
                console.log(`\n  ${title}${statusTag}`)
                for (const item of items) {
                    console.log(`    SKU: ${item.sku}  |  price: $${item.price.toFixed(2)}`)
                }
            }
        }

        // 3. Bonus: feed SKUs not found in store
        const notListed = [...feedSkus].filter((sku) => !variantMap.has(sku))
        console.log(`\n── Feed SKUs NOT listed in our store: ${notListed.length} ──`)
        if (notListed.length) {
            console.log(`  ${notListed.join(', ')}`)
        }
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal:', err.message)
    process.exit(1)
})
