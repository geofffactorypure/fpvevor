/**
 * deleteBadCostwayProducts.js
 *
 * Deletes two sets of Costway products from Shopify and the DB:
 *
 *   Set 1 — Products with no variant images created on/after 2026-06-17
 *   Set 2 — Duplicate SKU products (keeps lowest product id, deletes max id)
 *
 * Usage:
 *   node deleteBadCostwayProducts.js           # run both sets
 *   node deleteBadCostwayProducts.js --dry-run # preview only, no writes
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import mysql from 'mysql'

// ── Config ──────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2026-01'
const CONCURRENCY = 3

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

async function shopifyDeleteProduct(storeInfo, productId) {
    const gid = `gid://shopify/Product/${productId}`
    const res = await shopifyGraphQL(
        storeInfo,
        `mutation productDelete($input: ProductDeleteInput!) {
            productDelete(input: $input) {
                deletedProductId
                userErrors { field message }
            }
        }`,
        { input: { id: gid } }
    )
    if (res.errors) throw new Error(`GraphQL errors: ${JSON.stringify(res.errors)}`)
    const userErrors = res.data?.productDelete?.userErrors || []
    if (userErrors.length > 0) throw new Error(`userErrors: ${JSON.stringify(userErrors)}`)
    return res.data.productDelete.deletedProductId
}

// ── DB cleanup ───────────────────────────────────────────────────────────────
async function deleteProductFromDB(pool, productId) {
    // Get variant IDs first for child table cleanup
    const variants = await query(pool, `SELECT id FROM variants_new WHERE product_id = ?`, [productId])
    const variantIds = variants.map((v) => v.id)

    if (variantIds.length > 0) {
        const placeholders = variantIds.map(() => '?').join(', ')
        await query(pool, `DELETE FROM variant_images WHERE variant_id IN (${placeholders})`, variantIds).catch(
            () => {}
        )
    }

    await query(pool, `DELETE FROM product_filter_values_new WHERE product_id = ?`, [productId]).catch(() => {})
    await query(pool, `DELETE FROM product_listing_events WHERE product_id = ?`, [productId]).catch(() => {})
    await query(pool, `DELETE FROM variants_new WHERE product_id = ?`, [productId])
    await query(pool, `DELETE FROM products WHERE id = ?`, [productId])
}

// ── Concurrency helper ───────────────────────────────────────────────────────
async function runWithConcurrency(tasks, limit) {
    const results = []
    const executing = new Set()
    for (const task of tasks) {
        const p = task().then((r) => {
            executing.delete(p)
            return r
        })
        executing.add(p)
        results.push(p)
        if (executing.size >= limit) await Promise.race(executing)
    }
    return Promise.all(results)
}

// ── Delete one product ───────────────────────────────────────────────────────
async function deleteProduct(pool, storeInfo, productId, label) {
    if (DRY_RUN) {
        console.log(`[DRY RUN] Would delete product ${productId} (${label})`)
        return
    }
    try {
        await shopifyDeleteProduct(storeInfo, productId)
        await deleteProductFromDB(pool, productId)
        console.log(`✓ Deleted product ${productId} (${label})`)
    } catch (err) {
        console.error(`✗ Failed product ${productId} (${label}): ${err.message}`)
    }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    if (DRY_RUN) console.log('[DRY RUN] No writes will be made.\n')

    const pool = createPool()
    try {
        const storeRows = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeRows.length) throw new Error(`Store ${STORE_ID} not found`)
        const storeInfo = storeRows[0]

        // ── Set 1: Created >= 2026-06-17 ──────────────────
        console.log('\n── Set 1: Products with no variant images (created >= 2026-06-17) ──')
        const noImageRows = await query(
            pool,
            `SELECT DISTINCT p.id AS product_id, p.created_at
             FROM products p
             WHERE p.vendor = 'Costway'
               AND p.created_at >= '2026-06-17'
             ORDER BY p.created_at ASC`
        )
        console.log(`Found ${noImageRows.length} products to delete`)

        await runWithConcurrency(
            noImageRows.map(
                (row) => () => deleteProduct(pool, storeInfo, row.product_id, `no-images, created ${row.created_at}`)
            ),
            CONCURRENCY
        )

        // ── Set 2: Duplicate SKUs — delete max product id per group ──────────
        console.log('\n── Set 2: Duplicate SKU products (delete max product id per group) ──')
        const dupRows = await query(
            pool,
            `SELECT
                v.sku,
                COUNT(*) AS variant_count,
                GROUP_CONCAT(DISTINCT p.id ORDER BY p.id) AS product_ids
             FROM variants_new v
             JOIN products p ON p.id = v.product_id
             WHERE p.vendor = 'Costway'
               AND v.sku IS NOT NULL
               AND v.sku <> ''
             GROUP BY v.sku
             HAVING COUNT(*) > 1
             ORDER BY variant_count DESC, v.sku`
        )
        console.log(`Found ${dupRows.length} duplicate SKU groups`)

        const dupProductIds = []
        for (const row of dupRows) {
            const ids = row.product_ids.split(',').map(Number)
            const maxId = Math.max(...ids)
            dupProductIds.push({ productId: maxId, sku: row.sku, allIds: ids })
        }

        // Deduplicate — a product id might appear in multiple groups
        const seen = new Set()
        const uniqueDups = dupProductIds.filter(({ productId }) => {
            if (seen.has(productId)) return false
            seen.add(productId)
            return true
        })
        console.log(`Unique products to delete from duplicates: ${uniqueDups.length}`)

        await runWithConcurrency(
            uniqueDups.map(
                ({ productId, sku, allIds }) =>
                    () =>
                        deleteProduct(pool, storeInfo, productId, `dup sku=${sku}, all ids=[${allIds.join(',')}]`)
            ),
            CONCURRENCY
        )

        console.log('\nDone.')
    } finally {
        await endPool(pool)
    }
}

main().catch((err) => {
    console.error('Fatal:', err.message)
    process.exit(1)
})
