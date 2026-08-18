/**
 * syncGrizzlyShippingFees.js
 *
 * Reads grizzly_price_list_latest.csv and upserts the resolved shipping fee
 * for every Grizzly / Shop Fox / South Bend SKU into the grizzly_shipping_fees
 * table. Run this after every CSV refresh so the carrier rate service always
 * has up-to-date fees.
 *
 * Usage:
 *   node syncGrizzlyShippingFees.js            # upsert all brands
 *   node syncGrizzlyShippingFees.js --dry-run  # preview only, no DB writes
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fs from 'fs'
import mysql from 'mysql'
import { parse } from 'csv-parse/sync'

// ── Config ──────────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes('--dry-run')
const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

const ALLOWED_VENDORS = new Set(['Grizzly', 'Shop Fox', 'South Bend'])

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

// ── Pricing helpers (mirrors listGrizzlyProducts.js exactly) ─────────────────
function normalizeBrand(brand) {
    if (!brand) return 'Grizzly'
    const b = brand.trim()
    if (b.toLowerCase().startsWith('grizzly')) return 'Grizzly'
    return b
}

function lookupShippingCost(dealerPrice) {
    if (dealerPrice >= 150) return 0
    if (dealerPrice >= 100) return 21.99
    if (dealerPrice >= 50) return 18.99
    if (dealerPrice >= 15) return 16.99
    return 8.99
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const pool = createPool()

    try {
        const csvPath = new URL('./grizzly_price_list_latest.csv', import.meta.url)
        if (!fs.existsSync(csvPath)) {
            console.error('grizzly_price_list_latest.csv not found')
            process.exit(1)
        }

        console.log('Loading grizzly_price_list_latest.csv...')
        const csvContent = fs.readFileSync(csvPath, 'utf-8')
        const csvRows = parse(csvContent, {
            columns: true,
            skip_empty_lines: true,
            relax_column_count: true,
            relax_quotes: true,
            bom: true,
            from_line: 2,
        })

        const rows = csvRows
            .map((row) => {
                const sku = row['Item Number']?.trim()
                const vendor = normalizeBrand(row['Brand']?.trim())
                const dealerPrice = parseFloat((row['Dealer Price'] || '').replace(/[^0-9.]/g, '')) || 0
                const rawShipping = (row['Dealer Shipping Cost'] || '').trim()
                const shippingFee =
                    rawShipping.toLowerCase() === 'see chart'
                        ? lookupShippingCost(dealerPrice)
                        : parseFloat(rawShipping.replace(/[^0-9.]/g, '')) || 0
                const shipType = row['Ship Type']?.trim() || null
                return { sku, vendor, shippingFee, shipType }
            })
            .filter((r) => {
                if (!r.sku) return false
                if (r.sku.toUpperCase().startsWith('P')) return false
                if (!ALLOWED_VENDORS.has(r.vendor)) return false
                return true
            })

        console.log(`Found ${rows.length} eligible SKUs to sync`)

        if (DRY_RUN) {
            console.log('\nDRY RUN — no DB writes. First 10 rows:')
            console.table(rows.slice(0, 10))
            return
        }

        // Batch upsert in chunks of 500
        const CHUNK = 500
        let upserted = 0
        for (let i = 0; i < rows.length; i += CHUNK) {
            const chunk = rows.slice(i, i + CHUNK)
            // INSERT ... ON DUPLICATE KEY UPDATE
            const values = chunk.map((r) => [r.sku, r.shippingFee, r.shipType])
            await query(
                pool,
                `INSERT INTO grizzly_shipping_fees (sku, shipping_fee, ship_type)
                 VALUES ?
                 ON DUPLICATE KEY UPDATE
                   shipping_fee = VALUES(shipping_fee),
                   ship_type    = VALUES(ship_type),
                   updated_at   = CURRENT_TIMESTAMP`,
                [values]
            )
            upserted += chunk.length
            console.log(`  Upserted ${upserted}/${rows.length}...`)
        }

        console.log(`\n✓ Done! ${upserted} rows upserted into grizzly_shipping_fees.`)
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
