/**
 * checkNewCostwayFeedSkus.js
 *
 * Downloads the Costway feed, finds variant SKUs not in our DB, and emails
 * a CSV report.
 *
 * Usage:
 *   node checkNewCostwayFeedSkus.js          # downloads fresh feed
 *   node checkNewCostwayFeedSkus.js --cached  # reuse costway_data/feed_cache.csv
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
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'

// ── Config ──────────────────────────────────────────────────────────────────
const FEED_URL = 'https://www.costway.com/media/feed/US-Dropship-Shopify.csv'
const FEED_CACHE_PATH = './costway_data/feed_cache.csv'
const MIN_FEED_BYTES = 50 * 1024 * 1024
const STORE_ID = 1
const TO = 'gjarman@factorypure.com'
const FROM = 'gjarman@factorypure.com'
const USE_CACHE = process.argv.includes('--cached')

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

// ── CSV escape ───────────────────────────────────────────────────────────────
function csvEscape(val) {
    return `"${String(val ?? '').replace(/"/g, '""')}"`
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    // 1. Get the feed
    if (USE_CACHE) {
        if (!fs.existsSync(FEED_CACHE_PATH)) {
            throw new Error(`--cached flag used but ${FEED_CACHE_PATH} not found. Run without --cached first.`)
        }
        console.log(`Using cached feed: ${FEED_CACHE_PATH}`)
    } else {
        await downloadFeed()
    }

    // 2. Parse feed
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

    // 3. Build feed SKU → row map (Variant SKU is the key)
    //    Feed can have multiple rows per product (one per variant), deduplicate by SKU
    const feedBySkuMap = new Map() // sku -> first row with that sku
    for (const row of rows) {
        const sku = (row['Variant SKU'] || '').trim()
        if (!sku) continue
        if (!feedBySkuMap.has(sku)) feedBySkuMap.set(sku, row)
    }
    console.log(`Unique variant SKUs in feed: ${feedBySkuMap.size}`)

    // 4. Query DB for all existing Costway variant SKUs
    const pool = createPool()
    try {
        console.log('Querying DB for existing Costway SKUs...')
        const dbRows = await query(
            pool,
            `SELECT vn.sku
             FROM variants_new vn
             JOIN products p ON p.id = vn.product_id
             WHERE p.vendor = 'Costway'
               AND vn.sku IS NOT NULL
               AND vn.sku != ''`
        )
        const dbSkuSet = new Set(dbRows.map((r) => r.sku.trim()))
        console.log(`DB Costway SKUs: ${dbSkuSet.size}`)

        // 5. Find feed SKUs not in DB
        const newSkus = []
        for (const [sku, row] of feedBySkuMap) {
            if (!dbSkuSet.has(sku)) {
                newSkus.push({ sku, row })
            }
        }
        console.log(`New SKUs not in DB: ${newSkus.length}`)

        if (newSkus.length === 0) {
            console.log('No new SKUs found. No email sent.')
            return
        }

        // 6. Build CSV
        const headers = ['Variant SKU', 'Item No', 'Title', 'Type', 'Variant Price', 'Item Link']
        const csvLines = [headers.join(',')]
        for (const { sku, row } of newSkus) {
            csvLines.push(
                [
                    csvEscape(sku),
                    csvEscape(row['Item No'] || ''),
                    csvEscape(row['Title'] || ''),
                    csvEscape(row['Type'] || ''),
                    csvEscape(row['Variant Price'] || ''),
                    csvEscape(row['Item Link'] || ''),
                ].join(',')
            )
        }
        const csvContent = csvLines.join('\r\n')
        const base64Csv = Buffer.from(csvContent).toString('base64')

        // 7. Send email
        const csvName = 'new_costway_feed_skus.csv'
        const subject = `Costway Feed — ${newSkus.length} New SKU(s) Not In DB`
        const boundary = '----boundary_' + Date.now().toString(16)

        const rawMessage = [
            `From: ${FROM}`,
            `To: ${TO}`,
            `Subject: ${subject}`,
            `MIME-Version: 1.0`,
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            ``,
            `--${boundary}`,
            `Content-Type: text/plain; charset=UTF-8`,
            ``,
            `Found ${newSkus.length} Costway variant SKU(s) in the feed that are not in the database.`,
            ``,
            `Feed total unique SKUs: ${feedBySkuMap.size}`,
            `DB Costway SKUs: ${dbSkuSet.size}`,
            `New (missing) SKUs: ${newSkus.length}`,
            ``,
            `--${boundary}`,
            `Content-Type: text/csv; name="${csvName}"`,
            `Content-Disposition: attachment; filename="${csvName}"`,
            `Content-Transfer-Encoding: base64`,
            ``,
            base64Csv,
            ``,
            `--${boundary}--`,
        ].join('\r\n')

        const ses = new SESClient({ region: 'us-east-2' })
        await ses.send(
            new SendRawEmailCommand({
                RawMessage: { Data: Buffer.from(rawMessage) },
            })
        )
        console.log(`✓ Email sent to ${TO}: "${subject}"`)
    } finally {
        await endPool(pool)
    }
}

main().catch((err) => {
    console.error('Fatal error:', err.message)
    process.exit(1)
})
