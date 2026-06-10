import '../src/config.js'
import fetch from 'node-fetch'
import xlsx from 'xlsx'
import fs from 'fs'
import OpenAI from 'openai'
import mysql from 'mysql'

const { VEVOR_ENDPOINT, OPENAI_API_KEY, DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

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

async function getProductTypes(pool) {
    const rows = await query(
        pool,
        `SELECT DISTINCT product_type FROM products WHERE product_type IS NOT NULL AND product_type != '' ORDER BY product_type`
    )
    return rows.map((r) => r.product_type)
}

const client = new OpenAI({
    apiKey: OPENAI_API_KEY,
    timeout: 120000,
    maxRetries: 2,
})

const BATCH_SIZE = 30
const MODEL = 'gpt-5.4-mini'

function escapeCsv(val) {
    if (!val) return ''
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`
    }
    return val
}

function titleCase(str) {
    return str.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

function generateNewType(lastSegment) {
    // Strip leading adjectives that don't belong in product types
    const stripPrefixes = ['Commercial', 'Inflatable', 'Automatic', 'Manual']
    for (const prefix of stripPrefixes) {
        if (lastSegment.startsWith(prefix + ' ')) {
            lastSegment = lastSegment.slice(prefix.length + 1)
            break
        }
    }
    // Pluralize if needed
    return lastSegment.endsWith('s') || lastSegment.endsWith('ry') || lastSegment.endsWith('ing')
        ? lastSegment
        : lastSegment + 's'
}

async function main() {
    const pool = createPool()

    try {
        // 1. Load product types from DB
        console.log('Loading product types from database...')
        const ourTypes = await getProductTypes(pool)
        console.log(`Loaded ${ourTypes.length} product types from DB`)

        // 2. Get distinct types from Vevor feed
        console.log('Fetching Vevor feed...')
        const res = await fetch(VEVOR_ENDPOINT)
        const buffer = await res.arrayBuffer()
        const workbook = xlsx.read(Buffer.from(buffer))
        const rows = xlsx.utils.sheet_to_json(workbook.Sheets.feed)

        const vevorTypeSet = new Set()
        for (const row of rows) {
            const type = (row['Product type'] || '').trim()
            if (type) vevorTypeSet.add(type)
        }
        const vevorTypes = [...vevorTypeSet].sort()
        console.log(`Found ${vevorTypes.length} distinct Vevor types`)
        console.log(`Using ${ourTypes.length} FP product types from DB`)

        // 3. For each Vevor type, do AI comparison to find a mergeable value
        const batches = []
        for (let i = 0; i < vevorTypes.length; i += BATCH_SIZE) {
            batches.push(vevorTypes.slice(i, i + BATCH_SIZE))
        }

        console.log(`\nProcessing ${batches.length} batches of up to ${BATCH_SIZE} Vevor types each...\n`)

        // Output map: { calculatedType -> vevorType[] }
        const typeMap = new Map()

        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
            const batch = batches[batchIdx]
            console.log(`Batch ${batchIdx + 1}/${batches.length} (${batch.length} types)...`)

            try {
                const batchResults = await matchBatch(batch, ourTypes)
                for (const result of batchResults) {
                    let mappedType = result.mappedType

                    // If AI says no match, generate a new type from the last segment
                    if (!mappedType || mappedType === 'NONE') {
                        const segments = result.vevorType
                            .split('>')
                            .map((s) => s.trim())
                            .filter(Boolean)
                        mappedType = generateNewType(segments[segments.length - 1])
                    }

                    if (!typeMap.has(mappedType)) {
                        typeMap.set(mappedType, [])
                    }
                    typeMap.get(mappedType).push(result.vevorType)
                }
                console.log(`  -> Done`)
            } catch (err) {
                console.error(`  -> Error: ${err.message}`)
                // Fallback: generate types from last segment
                for (const vevorType of batch) {
                    const segments = vevorType
                        .split('>')
                        .map((s) => s.trim())
                        .filter(Boolean)
                    const mappedType = generateNewType(segments[segments.length - 1])
                    if (!typeMap.has(mappedType)) typeMap.set(mappedType, [])
                    typeMap.get(mappedType).push(vevorType)
                }
            }

            // Write progress to file after each batch
            writeOutput(typeMap, ourTypes)

            if (batchIdx < batches.length - 1) {
                await new Promise((r) => setTimeout(r, 200))
            }
        }

        // 4. Generate output map: calculated type -> vevor type(s)
        writeOutput(typeMap, ourTypes)
        console.log(`\nDone! Final output written to vevor_ai_type_merge.csv`)
    } finally {
        pool.end()
    }
}

function writeOutput(typeMap, ourTypes) {
    const ourTypesLower = new Set(ourTypes.map((t) => t.toLowerCase()))
    const outputRows = []
    const sortedKeys = [...typeMap.keys()].sort()
    for (const calculatedType of sortedKeys) {
        const displayType = titleCase(calculatedType)
        const isNew = !ourTypesLower.has(calculatedType.toLowerCase())
        const vevorTypesForKey = typeMap.get(calculatedType)
        for (const vevorType of vevorTypesForKey) {
            outputRows.push({
                'Calculated Type': displayType,
                Status: isNew ? 'New' : 'Merged',
                'Vevor Type': vevorType,
            })
        }
    }

    const csvHeaders = ['Calculated Type', 'Status', 'Vevor Type']
    const csvLines = [csvHeaders.join(',')]
    for (const row of outputRows) {
        csvLines.push(csvHeaders.map((h) => escapeCsv(row[h])).join(','))
    }

    const outputPath = 'vevor_ai_type_merge.csv'
    fs.writeFileSync(outputPath, csvLines.join('\n'))
}

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

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
