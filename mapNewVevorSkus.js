import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fs from 'fs'
import mysql from 'mysql'
import OpenAI from 'openai'
import { parse } from 'csv-parse/sync'
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'

/**
 * Map New Vevor SKUs
 *
 * Reads new_vevor_skus.csv (only the new/unmapped SKUs), uses AI to match
 * their Vevor product types to our existing FP product types, and appends
 * the results to vevor_sku_type_mapping.csv.
 *
 * Usage:
 *   node mapNewVevorSkus.js
 */

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER, OPENAI_API_KEY } = process.env

const INPUT_FILE = new URL('./new_vevor_skus.csv', import.meta.url)
const MAPPING_FILE = new URL('./vevor_sku_type_mapping.csv', import.meta.url)
const BATCH_SIZE = 30
const MODEL = 'gpt-5.4-mini'

// ── DB ──────────────────────────────────────────────────────────────────────
function createPool() {
    return mysql.createPool({
        connectionLimit: 3,
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

// ── AI ──────────────────────────────────────────────────────────────────────
const client = new OpenAI({ apiKey: OPENAI_API_KEY, timeout: 120000, maxRetries: 2 })

async function matchBatch(vevorTypeBatch, fpTypes) {
    const systemPrompt = `You are a product taxonomy expert for an e-commerce store. Given a list of Vevor product type paths (hierarchical, separated by ">"), map each one to the best matching product type from our store's existing type list.

Rules:
- Pick the closest semantic match from our existing types list
- Vevor paths are hierarchical (e.g. "Tools > Power Tools > Saws > Miter Saws") - use the full context to determine the best match
- If multiple segments match different types, prefer the most specific match
- If there is NO reasonable match in our existing types, set mappedType to "NONE" - we will generate a new type from the last segment
- Only use "NONE" when the Vevor type is genuinely a different product category with no close equivalent

Respond with a JSON object: { "results": [ { "vevorType": "<exact vevor type string>", "mappedType": "<our type or NONE>" } ] }`

    const userPrompt = `Our store's existing product types:
${fpTypes.join('\n')}

---

Map each of these Vevor product types to the best matching type from our list above (or "NONE" if no good match):

${vevorTypeBatch.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Return JSON with a "results" array containing one entry per Vevor type.`

    const response = await client.chat.completions.create({
        model: MODEL,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
    })

    const content = response.choices[0]?.message?.content
    if (!content) throw new Error('Empty response from OpenAI')

    const parsed = JSON.parse(content)
    const items = Array.isArray(parsed) ? parsed : parsed.results || parsed.items || Object.values(parsed)[0]

    if (!Array.isArray(items)) {
        throw new Error(`Unexpected response format: ${content.slice(0, 200)}`)
    }

    return items.map((item) => ({
        vevorType: item.vevorType,
        mappedType: item.mappedType,
    }))
}

function generateNewType(lastSegment) {
    const stripPrefixes = ['Commercial', 'Inflatable', 'Automatic', 'Manual']
    for (const prefix of stripPrefixes) {
        if (lastSegment.startsWith(prefix + ' ')) {
            lastSegment = lastSegment.slice(prefix.length + 1)
            break
        }
    }
    return lastSegment.endsWith('s') || lastSegment.endsWith('ry') || lastSegment.endsWith('ing')
        ? lastSegment
        : lastSegment + 's'
}

function escapeCsv(val) {
    if (!val) return ''
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`
    }
    return val
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    // 1. Read new SKUs
    if (!fs.existsSync(INPUT_FILE)) {
        console.error('new_vevor_skus.csv not found. Run findNewVevorSkus.js first.')
        process.exit(1)
    }

    const inputCsv = fs.readFileSync(INPUT_FILE, 'utf-8')
    const newRows = parse(inputCsv, { columns: true, skip_empty_lines: true, relax_column_count: true })
    console.log(`Loaded ${newRows.length} new SKU(s) from new_vevor_skus.csv`)

    if (newRows.length === 0) {
        console.log('Nothing to map. Exiting.')
        return
    }

    // 2. Get distinct Vevor types from the new SKUs only
    const vevorTypeToSkus = new Map()
    for (const row of newRows) {
        const type = (row['Vevor Product Type'] || '').trim()
        const sku = (row['SKU'] || '').trim()
        if (type && sku) {
            if (!vevorTypeToSkus.has(type)) vevorTypeToSkus.set(type, [])
            vevorTypeToSkus.get(type).push(row)
        }
    }
    const distinctTypes = [...vevorTypeToSkus.keys()].sort()
    console.log(`Found ${distinctTypes.length} distinct Vevor type(s) to map`)

    // 3. Get all existing product types from DB
    const pool = createPool()
    let fpTypes
    try {
        const rows = await query(
            pool,
            `SELECT DISTINCT product_type FROM products WHERE product_type IS NOT NULL AND product_type != '' ORDER BY product_type`
        )
        fpTypes = rows.map((r) => r.product_type)
        console.log(`Loaded ${fpTypes.length} existing FP product types from DB`)
    } finally {
        pool.end()
    }

    // 4. AI match in batches
    const typeMapping = new Map() // vevorType -> calculatedType
    const batches = []
    for (let i = 0; i < distinctTypes.length; i += BATCH_SIZE) {
        batches.push(distinctTypes.slice(i, i + BATCH_SIZE))
    }

    console.log(`\nProcessing ${batches.length} batch(es)...\n`)

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx]
        console.log(`Batch ${batchIdx + 1}/${batches.length} (${batch.length} types)...`)

        try {
            const results = await matchBatch(batch, fpTypes)
            for (const result of results) {
                let mappedType = result.mappedType
                if (!mappedType || mappedType === 'NONE') {
                    const segments = result.vevorType
                        .split('>')
                        .map((s) => s.trim())
                        .filter(Boolean)
                    mappedType = generateNewType(segments[segments.length - 1])
                }
                typeMapping.set(result.vevorType, mappedType)
            }
            console.log(`  -> Mapped ${results.length} type(s)`)
        } catch (err) {
            console.error(`  -> Error: ${err.message}, using fallback`)
            for (const vevorType of batch) {
                const segments = vevorType
                    .split('>')
                    .map((s) => s.trim())
                    .filter(Boolean)
                typeMapping.set(vevorType, generateNewType(segments[segments.length - 1]))
            }
        }

        if (batchIdx < batches.length - 1) {
            await new Promise((r) => setTimeout(r, 200))
        }
    }

    // 5. Build new mapping rows and append to CSV
    const newMappingLines = []
    for (const row of newRows) {
        const vevorType = (row['Vevor Product Type'] || '').trim()
        const mappedType = typeMapping.get(vevorType) || ''
        const line = [escapeCsv(row['SKU']), escapeCsv(row['Title']), escapeCsv(vevorType), escapeCsv(mappedType)].join(
            ','
        )
        newMappingLines.push(line)
    }

    fs.appendFileSync(MAPPING_FILE, '\n' + newMappingLines.join('\n'))
    console.log(`\n✓ Appended ${newMappingLines.length} SKU(s) to vevor_sku_type_mapping.csv`)

    // Print summary
    const mappedTypes = new Set([...typeMapping.values()])
    const newTypes = [...mappedTypes].filter((t) => !fpTypes.includes(t))
    console.log(
        `  Mapped to ${mappedTypes.size} distinct type(s) (${newTypes.length} new, ${mappedTypes.size - newTypes.length} existing)`
    )
    if (newTypes.length > 0) {
        console.log(`  New types: ${newTypes.slice(0, 10).join(', ')}${newTypes.length > 10 ? '...' : ''}`)
    }

    // 6. Email the newly mapped SKUs
    const csvHeader = 'SKU,Title,Vevor Product Type,Mapped Product Type'
    const csvContent = [csvHeader, ...newMappingLines].join('\r\n')
    await sendEmail(csvContent, newMappingLines.length)
}

async function sendEmail(csvContent, count) {
    const TO = 'gjarman@factorypure.com'
    const FROM = 'gjarman@factorypure.com'
    const ses = new SESClient({ region: 'us-east-2' })
    const boundary = '----boundary_' + Date.now().toString(16)
    const csvBase64 = Buffer.from(csvContent).toString('base64')

    const rawMessage = [
        `From: ${FROM}`,
        `To: ${TO}`,
        `Subject: Vevor — ${count} New SKUs Mapped`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset=UTF-8`,
        ``,
        `${count} new SKU(s) have been mapped and appended to vevor_sku_type_mapping.csv.`,
        ``,
        `--${boundary}`,
        `Content-Type: text/csv; name="new_mapped_skus.csv"`,
        `Content-Disposition: attachment; filename="new_mapped_skus.csv"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        csvBase64,
        ``,
        `--${boundary}--`,
    ].join('\r\n')

    try {
        await ses.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(rawMessage) } }))
        console.log(`Email sent to ${TO}`)
    } catch (err) {
        console.error('Failed to send email:', err.message)
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
