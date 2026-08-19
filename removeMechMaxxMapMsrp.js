/**
 * removeMechMaxxMapMsrp.js
 *
 * Removes custom.map_price and custom.msrp metafields from every
 * MechMaxx variant in the Shopify store.
 *
 * Usage:
 *   node removeMechMaxxMapMsrp.js            # live update
 *   node removeMechMaxxMapMsrp.js --dry-run  # preview only
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import mysql from 'mysql'

// ── Config ───────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2026-01'
const VENDOR = 'MechMaxx'
const DRY_RUN = process.argv.includes('--dry-run')
const CONCURRENCY = 5
const TARGET_KEYS = new Set(['map_price', 'msrp'])

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

// Returns array of { variantSku, metafieldId, key } for all map_price / msrp metafields
async function fetchMetafieldIds(storeInfo) {
    const results = []
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
                            variants(first: 100) {
                                nodes {
                                    id
                                    sku
                                    metafields(first: 20, namespace: "custom") {
                                        nodes {
                                            key
                                        }
                                    }
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
            for (const variant of edge.node.variants.nodes) {
                for (const mf of variant.metafields.nodes) {
                    if (TARGET_KEYS.has(mf.key)) {
                        results.push({ sku: (variant.sku || '').trim(), ownerId: variant.id, key: mf.key })
                    }
                }
            }
        }

        const hasNextPage = data.products.pageInfo.hasNextPage
        cursor = hasNextPage ? edges[edges.length - 1].cursor : null
        console.log(`  Page ${page}: ${edges.length} products scanned (${results.length} metafields found so far)`)
    } while (cursor)

    return results
}

async function deleteMetafields(storeInfo, ids) {
    const data = await shopifyGraphQL(
        storeInfo,
        `mutation metafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
            metafieldsDelete(metafields: $metafields) {
                deletedMetafields { key namespace ownerId }
                userErrors { field message }
            }
        }`,
        { metafields: ids.map(({ ownerId, key }) => ({ ownerId, namespace: 'custom', key })) }
    )
    const errors = data.metafieldsDelete?.userErrors
    if (errors?.length > 0) throw new Error(`metafieldsDelete errors: ${JSON.stringify(errors)}`)
    return data.metafieldsDelete.deletedMetafields?.length ?? 0
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n═══ Remove MechMaxx map_price + msrp Metafields ═══')
    console.log(`Dry Run: ${DRY_RUN}\n`)

    const pool = createPool()

    try {
        const [storeInfo] = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)
        console.log(`Using store: ${storeInfo.shopify_name}\n`)

        console.log('Scanning MechMaxx variants for map_price / msrp metafields...')
        const found = await fetchMetafieldIds(storeInfo)
        console.log(`\nFound ${found.length} metafield(s) to delete.`)

        if (found.length === 0) {
            console.log('Nothing to delete. Exiting.')
            return
        }

        if (DRY_RUN) {
            console.log('\n[DRY RUN] Would delete:')
            for (const f of found) {
                console.log(`  [${f.sku}] custom.${f.key}  (owner: ${f.ownerId})`)
            }
            console.log(`\n[DRY RUN] ${found.length} metafield(s) would be deleted. No changes made.`)
            return
        }

        // Delete in batches of 250 (Shopify limit per metafieldsDelete call)
        const BATCH_SIZE = 250
        let totalDeleted = 0
        let failed = 0

        for (let i = 0; i < found.length; i += BATCH_SIZE * CONCURRENCY) {
            const concurrentBatches = []
            for (let j = 0; j < CONCURRENCY && i + j * BATCH_SIZE < found.length; j++) {
                const slice = found.slice(i + j * BATCH_SIZE, i + (j + 1) * BATCH_SIZE)
                concurrentBatches.push(slice)
            }

            await Promise.all(
                concurrentBatches.map(async (batch) => {
                    try {
                        const deleted = await deleteMetafields(storeInfo, batch)
                        totalDeleted += deleted
                        for (const f of batch) {
                            console.log(`  ✓ [${f.sku}] custom.${f.key} deleted`)
                        }
                    } catch (err) {
                        console.error(`  ✗ Batch failed: ${err.message}`)
                        failed += batch.length
                    }
                })
            )
        }

        console.log(`\nDone. Deleted: ${totalDeleted}, Failed: ${failed}`)
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
