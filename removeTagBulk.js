import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import mysql from 'mysql'

/**
 * Bulk Tag Removal Script
 *
 * Removes a specified tag from products matching a filter (vendor, product_type, or all).
 * Updates both the database (product_tags table) and Shopify.
 *
 * Usage:
 *   node removeTagBulk.js <tag> [--vendor=Vevor] [--product-type="Ultrasonic Cleaners"] [--dry-run]
 *
 * Examples:
 *   node removeTagBulk.js "clearance" --vendor=Vevor
 *   node removeTagBulk.js "summer-sale" --product-type="Ultrasonic Cleaners"
 *   node removeTagBulk.js "old-tag" --vendor=Vevor --dry-run
 */

// ── Config ──────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2025-01'
const BATCH_SIZE = 250 // DB query batch size
const SHOPIFY_BATCH_SIZE = 25 // Shopify metafieldsSet / tagsRemove batch size

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

// ── Parse CLI Args ──────────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2)
    const tag = args.find((a) => !a.startsWith('--'))
    if (!tag) {
        console.error('Usage: node removeTagBulk.js <tag> [--vendor=X] [--product-type=X] [--dry-run]')
        process.exit(1)
    }

    const vendor = args.find((a) => a.startsWith('--vendor='))?.split('=')[1] || null
    const productType = args.find((a) => a.startsWith('--product-type='))?.split('=')[1] || null
    const dryRun = args.includes('--dry-run')

    return { tag, vendor, productType, dryRun }
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

async function removeTagsFromShopify(storeInfo, productGids, tag) {
    // Use tagsRemove mutation in batches
    for (let i = 0; i < productGids.length; i += SHOPIFY_BATCH_SIZE) {
        const batch = productGids.slice(i, i + SHOPIFY_BATCH_SIZE)

        // tagsRemove only works on one product at a time, so we loop
        for (const gid of batch) {
            const result = await shopifyGraphQL(
                storeInfo,
                `mutation tagsRemove($id: ID!, $tags: [String!]!) {
                    tagsRemove(id: $id, tags: $tags) {
                        node { id }
                        userErrors { field message }
                    }
                }`,
                { id: gid, tags: [tag] }
            )

            const errors = result.data?.tagsRemove?.userErrors
            if (errors && errors.length > 0) {
                console.error(`  Shopify error for ${gid}:`, errors)
            }
        }

        // Brief pause between batches to avoid rate limits
        if (i + SHOPIFY_BATCH_SIZE < productGids.length) {
            await new Promise((resolve) => setTimeout(resolve, 500))
        }
    }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const { tag, vendor, productType, dryRun } = parseArgs()
    const pool = createPool()

    try {
        console.log(`\n═══ Bulk Tag Removal ═══`)
        console.log(`Tag to remove: "${tag}"`)
        if (vendor) console.log(`Vendor filter: ${vendor}`)
        if (productType) console.log(`Product type filter: ${productType}`)
        console.log(`Dry Run: ${dryRun}\n`)

        // 1. Get store info
        const [storeInfo] = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)

        // 2. Find products with this tag matching the filters
        let sql = `
            SELECT p.id, p.title, p.admin_graphql_api_id
            FROM products p
            INNER JOIN product_tags pt ON pt.product_id = p.id AND pt.store_id = p.store_id
            WHERE pt.tag = ? AND p.store_id = ?
        `
        const params = [tag, STORE_ID]

        if (vendor) {
            sql += ` AND p.vendor = ?`
            params.push(vendor)
        }
        if (productType) {
            sql += ` AND p.product_type = ?`
            params.push(productType)
        }

        const products = await query(pool, sql, params)
        console.log(`Found ${products.length} product(s) with tag "${tag}"`)

        if (products.length === 0) {
            console.log('Nothing to do. Exiting.')
            return
        }

        // Show first few
        const preview = products.slice(0, 10)
        for (const p of preview) {
            console.log(`  • [${p.id}] ${p.title}`)
        }
        if (products.length > 10) {
            console.log(`  ... and ${products.length - 10} more`)
        }

        if (dryRun) {
            console.log(`\n[DRY RUN] Would remove tag "${tag}" from ${products.length} product(s)`)
            return
        }

        // 3. Remove from product_tags table
        const productIds = products.map((p) => p.id)
        for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
            const batch = productIds.slice(i, i + BATCH_SIZE)
            await query(pool, `DELETE FROM product_tags WHERE tag = ? AND store_id = ? AND product_id IN (?)`, [
                tag,
                STORE_ID,
                batch,
            ])
        }
        console.log(`\n✓ Removed tag from product_tags table`)

        // 4. Remove from Shopify
        const productGids = products.map((p) => p.admin_graphql_api_id).filter(Boolean)
        if (productGids.length > 0) {
            console.log(`Removing tag from ${productGids.length} product(s) on Shopify...`)
            await removeTagsFromShopify(storeInfo, productGids, tag)
            console.log(`✓ Removed tag from Shopify`)
        } else {
            console.log(`No Shopify GIDs found, skipping Shopify update`)
        }

        console.log(`\n═══ Done ═══`)
        console.log(`Removed tag "${tag}" from ${products.length} product(s)`)
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
