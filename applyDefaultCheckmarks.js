import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import mysql from 'mysql'

/**
 * Apply company default checkmarks to all Vevor products.
 *
 * Reads the default checkmarks from company_product_setup_defaults,
 * then sets the custom.checkmarks metafield on every Vevor product in Shopify.
 *
 * Usage:
 *   node applyDefaultCheckmarks.js [--dry-run]
 */

// ── Config ──────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2025-01'
const CONCURRENCY = 10
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
        console.log(`\n═══ Apply Default Checkmarks to Vevor Products ═══`)
        console.log(`Dry Run: ${DRY_RUN}\n`)

        // 1. Get store info
        const [storeInfo] = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)

        // 2. Get company default checkmarks
        const [defaults] = await query(
            pool,
            `SELECT d.checkmarks
             FROM company_product_setup_defaults d
             JOIN ${STORE_ID}_companies c ON c.id = d.company_id
             WHERE c.shopify_vendor_name = ?`,
            ['Vevor']
        )

        if (!defaults || !defaults.checkmarks) {
            throw new Error('No default checkmarks found for Vevor in company_product_setup_defaults')
        }

        const checkmarks =
            typeof defaults.checkmarks === 'string' ? JSON.parse(defaults.checkmarks) : defaults.checkmarks

        console.log(`Default checkmarks (${checkmarks.length}):`)
        for (const c of checkmarks) {
            console.log(`  • ${c}`)
        }
        console.log()

        // 3. Get all Vevor products with their Shopify GIDs
        const products = await query(
            pool,
            `SELECT p.id, p.title, p.admin_graphql_api_id
             FROM products p
             WHERE p.vendor = 'Vevor'
               AND p.store_id = ?
               AND p.admin_graphql_api_id IS NOT NULL`,
            [STORE_ID]
        )

        console.log(`Found ${products.length} Vevor product(s) to update\n`)

        if (products.length === 0) {
            console.log('Nothing to do. Exiting.')
            return
        }

        if (DRY_RUN) {
            const preview = products.slice(0, 10)
            for (const p of preview) {
                console.log(`  • [${p.id}] ${p.title}`)
            }
            if (products.length > 10) {
                console.log(`  ... and ${products.length - 10} more`)
            }
            console.log(`\n[DRY RUN] Would set checkmarks on ${products.length} product(s)`)
            return
        }

        // 4. Update checkmarks metafield on Shopify (25 per mutation call — Shopify limit)
        const BATCH_SIZE = 25
        const checkmarksValue = JSON.stringify(checkmarks)
        let done = 0
        let errors = 0

        for (let i = 0; i < products.length; i += BATCH_SIZE) {
            const batch = products.slice(i, i + BATCH_SIZE)
            const metafields = batch.map(({ admin_graphql_api_id: gid }) => ({
                ownerId: gid,
                namespace: 'custom',
                key: 'checkmarks',
                value: checkmarksValue,
                type: 'list.single_line_text_field',
            }))

            const result = await shopifyGraphQL(
                storeInfo,
                `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
                    metafieldsSet(metafields: $metafields) {
                        metafields { id }
                        userErrors { field message }
                    }
                }`,
                { metafields }
            )

            const userErrors = result.data?.metafieldsSet?.userErrors
            if (userErrors && userErrors.length > 0) {
                console.error(`  Batch errors:`, userErrors)
                errors += userErrors.length
            }
            if (result.errors) {
                console.error(`  GraphQL errors:`, result.errors)
                errors++
            }

            done += batch.length
            console.log(`  Progress: ${done}/${products.length}`)
        }

        console.log(`\n═══ Done ═══`)
        console.log(
            `Updated checkmarks on ${products.length - errors} product(s)${errors ? ` (${errors} error(s))` : ''}`
        )
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
