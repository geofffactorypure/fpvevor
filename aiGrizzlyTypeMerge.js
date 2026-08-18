import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fs from 'fs'
import OpenAI from 'openai'
import mysql from 'mysql'
import { parse } from 'csv-parse/sync'

const { OPENAI_AI_LISTER_API_KEY, DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

const BATCH_SIZE = 25
const OUTPUT_PATH = 'grizzly_sku_type_mapping.csv'

// ── DB ───────────────────────────────────────────────────────────────────────
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

// ── Helpers ──────────────────────────────────────────────────────────────────
function escapeCsv(val) {
    if (val === null || val === undefined) return ''
    const s = String(val)
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`
    }
    return s
}

function titleCase(str) {
    return str.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

function generateNewType(title) {
    // Take first 3 meaningful words from the description as a type seed
    const words = title.trim().split(/\s+/).slice(0, 3).join(' ')
    return titleCase(words.endsWith('s') ? words : words + 's')
}

// ── AI ───────────────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: OPENAI_AI_LISTER_API_KEY })

const SYSTEM_PROMPT = `You are a product taxonomy expert for a US e-commerce store that sells industrial and outdoor power equipment (Grizzly, Shop Fox, South Bend brands).

Given a list of products (each with a SKU and description/title), map each one to the most appropriate product type.

Rules:
- First try to match an existing product type from the provided list (exact match preferred, semantic match acceptable)
- If no existing type fits reasonably well, propose a NEW product type that:
  - Is a clear plural noun (e.g. "Band Saws", "Wood Lathes", "Jointers")
  - Is concise (2-4 words max)
  - Is suitable as a Shopify collection/product type label
- Set "mappedType" to the matched or proposed type
- Set "isNew" to true if you're proposing a new type, false if matching existing
- Respond ONLY with a raw JSON array, no markdown, no code fences`

async function matchBatch(batch, existingTypes) {
    const prompt = `Existing product types:\n${existingTypes.join('\n')}\n\nProducts to classify:\n${JSON.stringify(batch, null, 2)}\n\nRespond with a JSON array: [{ "sku": "...", "mappedType": "...", "isNew": true|false }, ...]`

    const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
        ],
        temperature: 0,
    })

    const raw = (response.choices[0].message.content || '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim()

    return JSON.parse(raw)
}

// ── CSV output ───────────────────────────────────────────────────────────────
const CSV_HEADERS = ['SKU', 'Title', 'Mapped Product Type', 'Status']

function writeOutput(rows) {
    const lines = [CSV_HEADERS.join(',')]
    for (const row of rows) {
        lines.push(CSV_HEADERS.map((h) => escapeCsv(row[h])).join(','))
    }
    fs.writeFileSync(OUTPUT_PATH, lines.join('\n'))
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const pool = createPool()

    try {
        // 1. Load existing product types from DB
        console.log('Loading product types from database...')
        const typeRows = await query(
            pool,
            `SELECT DISTINCT product_type FROM products WHERE product_type IS NOT NULL AND product_type != '' ORDER BY product_type`
        )
        const existingTypes = typeRows.map((r) => r.product_type)
        console.log(`Loaded ${existingTypes.length} product types from DB`)

        // 2. Load grizzly.csv → items to classify
        console.log('Loading grizzly.csv...')
        const csvRows = parse(fs.readFileSync('./grizzly.csv', 'utf-8'), {
            columns: true,
            skip_empty_lines: true,
            relax_column_count: true,
            relax_quotes: true,
            bom: true,
        })

        const items = csvRows
            .map((row) => ({
                sku: row['Item Number']?.trim() || '',
                title: row['Description']?.trim() || '',
            }))
            .filter((item) => item.sku && item.title)

        const skipped = csvRows.length - items.length
        if (skipped > 0) console.warn(`Skipped ${skipped} row(s) with no SKU or description`)
        console.log(`${items.length} products to classify`)

        // 3. Process in batches
        const batches = []
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            batches.push(items.slice(i, i + BATCH_SIZE))
        }
        console.log(`Processing ${batches.length} batch(es) of up to ${BATCH_SIZE}...\n`)

        const outputRows = []

        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
            const batch = batches[batchIdx]
            console.log(`Batch ${batchIdx + 1}/${batches.length} (${batch.length} products)...`)

            let results
            try {
                results = await matchBatch(batch, existingTypes)
            } catch (err) {
                console.error(`  -> AI error: ${err.message}. Falling back to title-based generation.`)
                results = batch.map((item) => ({
                    sku: item.sku,
                    mappedType: generateNewType(item.title),
                    isNew: true,
                }))
            }

            // Build a quick lookup for this batch
            const resultMap = new Map(results.map((r) => [r.sku, r]))

            for (const item of batch) {
                const result = resultMap.get(item.sku)
                const mappedType = result?.mappedType || generateNewType(item.title)
                const isNew = result?.isNew ?? true
                outputRows.push({
                    SKU: item.sku,
                    Title: item.title,
                    'Mapped Product Type': mappedType,
                    Status: isNew ? 'New' : 'Matched',
                })
            }

            // Write progress after each batch
            writeOutput(outputRows)
            console.log(`  -> Done. Written ${outputRows.length} rows so far.`)

            if (batchIdx < batches.length - 1) {
                await new Promise((r) => setTimeout(r, 300))
            }
        }

        writeOutput(outputRows)
        console.log(`\nDone! ${outputRows.length} products written to ${OUTPUT_PATH}`)

        // Summary
        const newCount = outputRows.filter((r) => r.Status === 'New').length
        const matchedCount = outputRows.filter((r) => r.Status === 'Matched').length
        const uniqueTypes = [...new Set(outputRows.map((r) => r['Mapped Product Type']))].sort()
        console.log(`\nSummary: ${matchedCount} matched existing types, ${newCount} new types proposed`)
        console.log(`Unique mapped types (${uniqueTypes.length}):`)
        uniqueTypes.forEach((t) => {
            const skus = outputRows.filter((r) => r['Mapped Product Type'] === t)
            console.log(`  ${t} (${skus.length})`)
        })
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
