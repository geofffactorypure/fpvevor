import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import mysql from 'mysql'

/**
 * Remove "Needs Review" tag from Vevor products that have no "Reason:" tags.
 *
 * Finds products with the "Needs Review" tag but no tags matching "Reason: *",
 * then removes "Needs Review" from both Shopify and the DB.
 *
 * Usage:
 *   node cleanNeedsReview.js [--dry-run]
 */

// ── Config ──────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2025-01'
const CONCURRENCY = 10 // Parallel Shopify requests (Plus: 10k bucket, 1k/sec restore, 10pt per mutation)
const DB_BATCH_SIZE = 250
const DRY_RUN = process.argv.includes('--dry-run')
const NEEDS_REVIEW_TAG = 'Needs Review'

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

// ── Shopify ─────────────────────────────────────────────────────────────────
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

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const pool = createPool()

    try {
        console.log(`\n═══ Clean "Needs Review" Tags ═══`)
        console.log(`Dry Run: ${DRY_RUN}\n`)

        // 1. Get store info
        const [storeInfo] = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)

        // 2. Find Vevor products with "Needs Review" tag
        const productsWithNeedsReview = await query(
            pool,
            `SELECT p.id, p.title, p.admin_graphql_api_id
             FROM products p
             INNER JOIN product_tags pt ON pt.product_id = p.id AND pt.store_id = p.store_id
             WHERE p.vendor = 'Vevor'
               AND p.store_id = ?
               AND pt.tag = ?`,
            [STORE_ID, NEEDS_REVIEW_TAG]
        )

        console.log(`Found ${productsWithNeedsReview.length} Vevor product(s) with "${NEEDS_REVIEW_TAG}" tag`)

        if (productsWithNeedsReview.length === 0) {
            console.log('Nothing to do. Exiting.')
            return
        }

        // 3. Check which of those have any "Reason:" tags
        const productIds = productsWithNeedsReview.map((p) => p.id)
        const reasonTags = await query(
            pool,
            `SELECT product_id FROM product_tags
             WHERE store_id = ? AND product_id IN (?) AND tag LIKE 'Reason:%'`,
            [STORE_ID, productIds]
        )
        const hasReasonTagIds = new Set(reasonTags.map((r) => r.product_id))

        // 4. Filter to products with NO reason tags
        const productsToClean = productsWithNeedsReview.filter((p) => !hasReasonTagIds.has(p.id))

        console.log(`${hasReasonTagIds.size} product(s) have reason tags (keeping "${NEEDS_REVIEW_TAG}")`)
        console.log(`${productsToClean.length} product(s) have NO reason tags (will remove "${NEEDS_REVIEW_TAG}")\n`)

        if (productsToClean.length === 0) {
            console.log('All products have reason tags. Nothing to clean.')
            return
        }

        // Show preview
        const preview = productsToClean.slice(0, 10)
        for (const p of preview) {
            console.log(`  • [${p.id}] ${p.title}`)
        }
        if (productsToClean.length > 10) {
            console.log(`  ... and ${productsToClean.length - 10} more`)
        }

        if (DRY_RUN) {
            console.log(`\n[DRY RUN] Would remove "${NEEDS_REVIEW_TAG}" from ${productsToClean.length} product(s)`)
            return
        }

        // 5. Remove from Shopify first
        const productGids = productsToClean.filter((p) => p.admin_graphql_api_id)
        console.log(`\nRemoving tag from ${productGids.length} product(s) on Shopify (concurrency: ${CONCURRENCY})...`)
        let shopifyDone = 0

        for (let i = 0; i < productGids.length; i += CONCURRENCY) {
            const chunk = productGids.slice(i, i + CONCURRENCY)
            const results = await Promise.all(
                chunk.map(({ admin_graphql_api_id: gid }) =>
                    shopifyGraphQL(
                        storeInfo,
                        `mutation tagsRemove($id: ID!, $tags: [String!]!) {
                            tagsRemove(id: $id, tags: $tags) {
                                node { id }
                                userErrors { field message }
                            }
                        }`,
                        { id: gid, tags: [NEEDS_REVIEW_TAG] }
                    )
                )
            )

            for (let j = 0; j < results.length; j++) {
                const errors = results[j].data?.tagsRemove?.userErrors
                if (errors && errors.length > 0) {
                    console.error(`  Shopify error for ${chunk[j].admin_graphql_api_id}:`, errors)
                }
            }

            shopifyDone += chunk.length
            if (shopifyDone % 100 < CONCURRENCY || shopifyDone === productGids.length) {
                console.log(`  Shopify progress: ${shopifyDone}/${productGids.length}`)
            }
        }
        console.log(`✓ Removed tag from Shopify`)

        // 6. Remove from product_tags table
        const cleanIds = productsToClean.map((p) => p.id)
        let dbDone = 0
        for (let i = 0; i < cleanIds.length; i += DB_BATCH_SIZE) {
            const batch = cleanIds.slice(i, i + DB_BATCH_SIZE)
            await query(pool, `DELETE FROM product_tags WHERE tag = ? AND store_id = ? AND product_id IN (?)`, [
                NEEDS_REVIEW_TAG,
                STORE_ID,
                batch,
            ])
            dbDone += batch.length
            console.log(`  DB progress: ${dbDone}/${cleanIds.length}`)
        }
        console.log(`✓ Removed tag from product_tags table`)

        console.log(`\n═══ Done ═══`)
        console.log(`Removed "${NEEDS_REVIEW_TAG}" from ${productsToClean.length} product(s)`)
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
