/**
 * fixCostwayPartNumbers.js
 *
 * For each Costway variant that has no custom_part_number but does have a
 * custom_supplier_model_number, this script:
 *   1. Sets custom_part_number = custom_supplier_model_number in variants_new
 *   2. Upserts the Shopify metafield custom.part_number on the variant
 *
 * Usage:
 *   node fixCostwayPartNumbers.js           # live run
 *   node fixCostwayPartNumbers.js --dry-run # preview only, no writes
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import mysql from 'mysql'

// ── Config ──────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2026-01'
const BATCH_SIZE = 25
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
        console.log(`\n═══ Fix Costway Part Numbers ═══`)
        console.log(`Dry Run: ${DRY_RUN}\n`)

        // 1. Get store info
        const [storeInfo] = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)

        // 2. Find Costway variants with no custom_part_number but with custom_supplier_model_number
        const variants = await query(
            pool,
            `SELECT vn.id, vn.custom_supplier_model_number, p.title
             FROM variants_new vn
             JOIN products p ON p.id = vn.product_id
             WHERE p.vendor = 'Costway'
               AND vn.store_id = ?
               AND (vn.custom_part_number IS NULL OR vn.custom_part_number = '')
               AND vn.custom_supplier_model_number IS NOT NULL
               AND vn.custom_supplier_model_number != ''`,
            [STORE_ID]
        )

        console.log(`Found ${variants.length} Costway variant(s) to update\n`)

        if (variants.length === 0) {
            console.log('Nothing to do. Exiting.')
            return
        }

        if (DRY_RUN) {
            const preview = variants.slice(0, 10)
            for (const v of preview) {
                console.log(`  • variant ${v.id} (${v.title})`)
                console.log(`      custom_part_number ← "${v.custom_supplier_model_number}"`)
            }
            if (variants.length > 10) {
                console.log(`  ... and ${variants.length - 10} more`)
            }
            console.log(`\n[DRY RUN] Would update ${variants.length} variant(s)`)
            return
        }

        let dbUpdated = 0
        let shopifyUpdated = 0
        let errors = 0

        // 3. Update DB in batches
        for (let i = 0; i < variants.length; i += BATCH_SIZE) {
            const batch = variants.slice(i, i + BATCH_SIZE)
            const ids = batch.map((v) => v.id)
            await query(
                pool,
                `UPDATE variants_new
                 SET custom_part_number = custom_supplier_model_number
                 WHERE id IN (?)`,
                [ids]
            )
            dbUpdated += batch.length
            console.log(`DB progress: ${dbUpdated}/${variants.length}`)
        }

        console.log()

        // 4. Update Shopify metafield custom.part_number on each variant in batches
        for (let i = 0; i < variants.length; i += BATCH_SIZE) {
            const batch = variants.slice(i, i + BATCH_SIZE)
            const metafields = batch.map(({ id, custom_supplier_model_number: value }) => ({
                ownerId: `gid://shopify/ProductVariant/${id}`,
                namespace: 'custom',
                key: 'part_number',
                value,
                type: 'single_line_text_field',
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
                console.error(`  Shopify batch errors:`, userErrors)
                errors += userErrors.length
            }
            if (result.errors) {
                console.error(`  GraphQL errors:`, result.errors)
                errors++
            }

            shopifyUpdated += batch.length
            console.log(`Shopify progress: ${shopifyUpdated}/${variants.length}`)
        }

        console.log(`\n═══ Done ═══`)
        console.log(`DB updated:      ${dbUpdated}`)
        console.log(`Shopify updated: ${shopifyUpdated}${errors ? ` (${errors} error(s))` : ''}`)
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
