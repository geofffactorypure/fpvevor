import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import xlsx from 'xlsx'
import fs from 'fs'
import { parse } from 'csv-parse/sync'
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'

/**
 * Find New Vevor SKUs
 *
 * Compares the current Vevor feed against vevor_sku_type_mapping.csv
 * and saves any new (unmapped) SKUs to a CSV for review.
 *
 * Usage:
 *   node findNewVevorSkus.js
 */

const VEVOR_ENDPOINT = process.env.VEVOR_ENDPOINT
const MAPPING_FILE = new URL('./vevor_sku_type_mapping.csv', import.meta.url)
const OUTPUT_FILE = new URL('./new_vevor_skus.csv', import.meta.url)

const TO = 'gjarman@factorypure.com'
const FROM = 'gjarman@factorypure.com'

async function main() {
    // 1. Load existing mapping
    console.log('Loading existing SKU mapping...')
    const mappingCsv = fs.readFileSync(MAPPING_FILE, 'utf-8')
    const mappingRows = parse(mappingCsv, { columns: true, skip_empty_lines: true, relax_column_count: true })
    const mappedSkus = new Set(mappingRows.map((r) => r.SKU?.trim()).filter(Boolean))
    console.log(`Mapping has ${mappedSkus.size} SKUs`)

    // 2. Fetch Vevor feed
    console.log('Fetching Vevor feed...')
    const res = await fetch(VEVOR_ENDPOINT)
    const buffer = await res.arrayBuffer()
    const workbook = xlsx.read(Buffer.from(buffer))
    const feedRows = xlsx.utils.sheet_to_json(workbook.Sheets.feed)
    console.log(`Feed has ${feedRows.length} total rows`)

    // 3. Find new SKUs not in mapping
    const newRows = []
    for (const row of feedRows) {
        const sku = (row['SKU'] || '').trim()
        if (sku && !mappedSkus.has(sku)) {
            newRows.push({
                SKU: sku,
                Title: (row['Product title'] || '').trim(),
                'Vevor Product Type': (row['Product type'] || '').trim(),
                'Product Link': (row['Product link'] || '').trim(),
                Price: row['Price'] || '',
                'Mapped Product Type': '',
            })
        }
    }

    console.log(`Found ${newRows.length} new SKU(s) not in mapping`)

    if (newRows.length === 0) {
        console.log('Nothing new. Exiting.')
        return
    }

    // 4. Save to CSV
    const header = 'SKU,Title,Vevor Product Type,Product Link,Price,Mapped Product Type'
    const lines = newRows.map((r) => {
        const escape = (v) => `"${String(v).replace(/"/g, '""')}"`
        return [r.SKU, escape(r.Title), escape(r['Vevor Product Type']), r['Product Link'], r.Price, ''].join(',')
    })
    const newSkusCsv = [header, ...lines].join('\r\n')
    fs.writeFileSync(OUTPUT_FILE, newSkusCsv)
    console.log(`Saved to new_vevor_skus.csv`)

    // 5. Email both CSVs
    console.log('Sending email...')
    await sendEmail(newSkusCsv, mappingCsv, newRows.length)
}

async function sendEmail(newSkusCsv, mappingCsv, newCount) {
    const ses = new SESClient({ region: 'us-east-2' })
    const boundary = '----boundary_' + Date.now().toString(16)

    const newSkusBase64 = Buffer.from(newSkusCsv).toString('base64')
    const mappingBase64 = Buffer.from(mappingCsv).toString('base64')

    const rawMessage = [
        `From: ${FROM}`,
        `To: ${TO}`,
        `Subject: Vevor Feed — ${newCount} New SKUs Found`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset=UTF-8`,
        ``,
        `Found ${newCount} new SKU(s) in the Vevor feed that are not in the current mapping.`,
        ``,
        `Attached:`,
        `  1. new_vevor_skus.csv — the new products for review`,
        `  2. vevor_sku_type_mapping.csv — the current mapping`,
        ``,
        `--${boundary}`,
        `Content-Type: text/csv; name="new_vevor_skus.csv"`,
        `Content-Disposition: attachment; filename="new_vevor_skus.csv"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        newSkusBase64,
        ``,
        `--${boundary}`,
        `Content-Type: text/csv; name="vevor_sku_type_mapping.csv"`,
        `Content-Disposition: attachment; filename="vevor_sku_type_mapping.csv"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        mappingBase64,
        ``,
        `--${boundary}--`,
    ].join('\r\n')

    await ses.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(rawMessage) } }))
    console.log(`Email sent to ${TO}`)
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
