/**
 * migrateGrizzlyShippingProfiles.js
 *
 * One-time retroactive migration. Assigns every already-listed
 * Grizzly / Shop Fox / South Bend variant to the Grizzly delivery profile
 * so carrier-calculated shipping applies to all existing products.
 *
 * Requires GRIZZLY_DELIVERY_PROFILE_ID in .env — the GID noted after
 * running registerGrizzlyCarrierService.js and setting up the profile in
 * Shopify Admin.
 *
 * Usage:
 *   node migrateGrizzlyShippingProfiles.js            # live run
 *   node migrateGrizzlyShippingProfiles.js --dry-run  # preview only
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import mysql from 'mysql'

// ── Config ──────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2025-01'
const BATCH_SIZE = 250 // Shopify limit per deliveryProfileUpdate call
const DRY_RUN = process.argv.includes('--dry-run')

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER, GRIZZLY_DELIVERY_PROFILE_ID } = process.env

if (!GRIZZLY_DELIVERY_PROFILE_ID) {
    console.error('GRIZZLY_DELIVERY_PROFILE_ID is not set in .env')
    process.exit(1)
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

// ── Shopify ──────────────────────────────────────────────────────────────────
async function getStoreInfo(pool) {
    const rows = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
    if (!rows.length) throw new Error(`Store ${STORE_ID} not found`)
    return rows[0]
}

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

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const pool = createPool()

    try {
        const storeInfo = await getStoreInfo(pool)
        console.log(`Using store: ${storeInfo.shopify_name}`)

        // Query all listed Grizzly / Shop Fox / South Bend variant GIDs from DB
        console.log('Loading variant GIDs from database...')
        const variantRows = await query(
            pool,
            `SELECT vn.shopify_variant_id
             FROM variants_new vn
             JOIN products p ON p.id = vn.product_id
             WHERE p.vendor IN ('Grizzly', 'Shop Fox', 'South Bend')
               AND p.store_id = ?
               AND vn.shopify_variant_id IS NOT NULL`,
            [STORE_ID]
        )

        if (!variantRows.length) {
            console.log('No variant GIDs found in DB. Nothing to migrate.')
            return
        }

        const variantGids = variantRows.map((r) => `gid://shopify/ProductVariant/${r.shopify_variant_id}`)

        console.log(`Found ${variantGids.length} variants to assign to profile ${GRIZZLY_DELIVERY_PROFILE_ID}`)

        if (DRY_RUN) {
            console.log('\nDRY RUN — no Shopify calls. First 5 GIDs:')
            variantGids.slice(0, 5).forEach((g) => console.log(' ', g))
            return
        }

        // Batch into chunks of BATCH_SIZE and assign
        let assigned = 0
        let failed = 0
        for (let i = 0; i < variantGids.length; i += BATCH_SIZE) {
            const batch = variantGids.slice(i, i + BATCH_SIZE)
            const batchNum = Math.floor(i / BATCH_SIZE) + 1
            const totalBatches = Math.ceil(variantGids.length / BATCH_SIZE)
            console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} variants)...`)

            const res = await shopifyGraphQL(
                storeInfo,
                `mutation deliveryProfileUpdate($id: ID!, $profile: DeliveryProfileInput!) {
                    deliveryProfileUpdate(id: $id, profile: $profile) {
                        profile { id }
                        userErrors { field message }
                    }
                }`,
                {
                    id: GRIZZLY_DELIVERY_PROFILE_ID,
                    profile: { variantsToAssociate: batch },
                }
            )

            const userErrors = res?.data?.deliveryProfileUpdate?.userErrors
            if (userErrors?.length) {
                console.error(`Batch ${batchNum} user errors:`, JSON.stringify(userErrors))
                failed += batch.length
            } else if (res?.errors) {
                console.error(`Batch ${batchNum} GraphQL errors:`, JSON.stringify(res.errors))
                failed += batch.length
            } else {
                assigned += batch.length
                console.log(`  ✓ Assigned ${assigned}/${variantGids.length}`)
            }
        }

        console.log(`\n✓ Done! ${assigned} assigned, ${failed} failed.`)
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
