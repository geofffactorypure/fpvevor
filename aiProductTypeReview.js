/**
 * AI Product Type Review Script
 *
 * Reads needs_review.csv row by row (deduplicated by product ID),
 * queries the DB for all distinct product types, and asks OpenAI
 * to suggest the correct product type for each product.
 *
 * Outputs a new CSV (needs_review_ai.csv) with an ai_suggestion column
 * and emails it to gjarman@factorypure.com.
 *
 * Usage:
 *   node aiProductTypeReview.js
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fs from 'fs'
import { parse } from 'csv-parse/sync'
import mysql from 'mysql'
import OpenAI from 'openai'
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env
const STORE_ID = 1
const OUTPUT_FILE = './needs_review_ai.csv'
const CONCURRENCY = 5

const pool = mysql.createPool({
    connectionLimit: 3,
    host: DB_WRITE_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    port: 3306,
    database: 'main',
    timezone: '+00:00',
})

const query = (sql, args) =>
    new Promise((resolve, reject) => {
        pool.query(sql, args, (err, rows) => {
            if (err) return reject(err)
            resolve(rows)
        })
    })

const openai = new OpenAI({ apiKey: process.env.OPENAI_AI_LISTER_API_KEY })

async function getDistinctProductTypes() {
    const rows = await query(
        `SELECT DISTINCT product_type FROM products WHERE store_id = ? AND product_type IS NOT NULL AND product_type != '' ORDER BY product_type`,
        [STORE_ID]
    )
    return rows.map((r) => r.product_type)
}

async function suggestProductType(title, currentType, productTypes) {
    const response = await openai.chat.completions.create({
        model: 'gpt-5.4-mini',
        messages: [
            {
                role: 'system',
                content: `You are a product categorization expert for an e-commerce store. You will be given a product title and its current product type, along with a list of existing product types used in the store.

Your job is to suggest the most accurate product type for this product.

Rules:
- Pick from the existing product types list if there is a good match.
- If no existing type fits well, you may create a new product type. New types MUST be in plural form (e.g. "Pipe Benders" not "Pipe Bender", "Ventilator Fans" not "Ventilator Fan").
- Respond with ONLY the product type string, nothing else. No quotes, no explanation.

Here are the existing product types:
${productTypes.join('\n')}`,
            },
            {
                role: 'user',
                content: `Product Title: ${title}\nCurrent Product Type: ${currentType}`,
            },
        ],
    })

    return response.choices[0].message.content.trim()
}

async function sendEmail(csvContent, count) {
    const TO = 'gjarman@factorypure.com'
    const FROM = 'gjarman@factorypure.com'
    const SUBJECT = 'Vevor Products — AI Product Type Suggestions'
    const CSV_NAME = 'needs_review_ai.csv'

    const base64Csv = Buffer.from(csvContent).toString('base64')
    const boundary = '----boundary_' + Date.now().toString(16)

    const rawMessage = [
        `From: ${FROM}`,
        `To: ${TO}`,
        `Subject: ${SUBJECT}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset=UTF-8`,
        ``,
        `Attached is a CSV of ${count} Vevor product(s) with AI-suggested product types for review.`,
        ``,
        `--${boundary}`,
        `Content-Type: text/csv; name="${CSV_NAME}"`,
        `Content-Disposition: attachment; filename="${CSV_NAME}"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        base64Csv,
        ``,
        `--${boundary}--`,
    ].join('\r\n')

    const ses = new SESClient({ region: 'us-east-2' })
    await ses.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(rawMessage) } }))
    console.log(`Email sent to ${TO}`)
}

async function main() {
    try {
        console.log(`\n═══ AI Product Type Review ═══\n`)

        // 1. Get distinct product types from DB
        console.log('Loading distinct product types from DB...')
        const productTypes = await getDistinctProductTypes()
        console.log(`Found ${productTypes.length} distinct product types\n`)

        // 2. Read needs_review.csv
        const csvContent = fs.readFileSync('./needs_review.csv', 'utf-8')
        const rows = parse(csvContent, { columns: true, skip_empty_lines: true })

        // 3. Deduplicate by product ID
        const seen = new Set()
        const uniqueRows = []
        for (const row of rows) {
            if (!seen.has(row.id)) {
                seen.add(row.id)
                uniqueRows.push(row)
            }
        }
        console.log(`${rows.length} total rows, ${uniqueRows.length} unique products to review\n`)

        // 4. Process in batches
        const results = []
        for (let i = 0; i < uniqueRows.length; i += CONCURRENCY) {
            const batch = uniqueRows.slice(i, i + CONCURRENCY)
            const batchResults = await Promise.all(
                batch.map(async (row) => {
                    const suggested = await suggestProductType(row.title, row.product_type, productTypes)
                    // Track new types for subsequent batches
                    if (!productTypes.includes(suggested)) {
                        productTypes.push(suggested)
                    }
                    return { ...row, ai_suggestion: suggested }
                })
            )
            results.push(...batchResults)
            console.log(`  Processed ${Math.min(i + CONCURRENCY, uniqueRows.length)}/${uniqueRows.length}`)
        }

        // 5. Write output CSV (same format as input + ai_suggestion column)
        const escape = (val) => `"${(val || '').replace(/"/g, '""')}"`
        const outputLines = ['id,product_type,title,ai_suggestion']
        for (const r of results) {
            outputLines.push(`${r.id},${escape(r.product_type)},${escape(r.title)},${escape(r.ai_suggestion)}`)
        }
        const outputCsv = outputLines.join('\r\n')
        fs.writeFileSync(OUTPUT_FILE, outputCsv)
        console.log(`\nWrote ${results.length} rows to ${OUTPUT_FILE}`)

        // 6. Email the results
        await sendEmail(outputCsv, results.length)

        console.log(`\n═══ Done ═══\n`)
    } catch (err) {
        console.error('Error:', err)
    } finally {
        pool.end()
    }
}

main()
