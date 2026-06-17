import 'dotenv/config'
import fs from 'fs'
import mysql from 'mysql'
import OpenAI from 'openai'
import { parse } from 'csv-parse'
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'

const FEED_CACHE_FILE = './costway_data/feed_cache.csv'
const CATEGORY_COLUMN = process.env.COSTWAY_CATEGORY_COLUMN || process.argv[2] || 'Category'
const MODEL = process.env.COSTWAY_TYPE_MODEL || 'gpt-5.4-mini'
const BATCH_SIZE = parseInt(process.env.COSTWAY_TYPE_BATCH_SIZE || '30', 10)
const EMAIL_TO = process.env.COSTWAY_TYPE_EMAIL_TO || 'gjarman@factorypure.com'
const EMAIL_FROM = process.env.COSTWAY_TYPE_EMAIL_FROM || 'gjarman@factorypure.com'
const EMAIL_ENABLED = (process.env.COSTWAY_TYPE_EMAIL_ENABLED || 'true').toLowerCase() !== 'false'

function createPool() {
    const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env
    if (!DB_PASSWORD || !DB_WRITE_HOST || !DB_USER) {
        throw new Error('Missing DB credentials: DB_WRITE_HOST, DB_USER, DB_PASSWORD')
    }

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

function titleCase(str) {
    return str.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

function generateNewType(lastSegment) {
    let value = (lastSegment || '').trim().replace(/\s+/g, ' ')
    const stripPrefixes = ['Commercial', 'Inflatable', 'Automatic', 'Manual']
    for (const prefix of stripPrefixes) {
        if (value.startsWith(prefix + ' ')) {
            value = value.slice(prefix.length + 1)
            break
        }
    }

    if (!value) return ''

    return value.endsWith('s') || value.endsWith('ry') || value.endsWith('ing') ? value : value + 's'
}

function escapeCsv(val) {
    const str = String(val ?? '')
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`
    }
    return str
}

async function getDistinctCostwayTypes() {
    if (!fs.existsSync(FEED_CACHE_FILE)) {
        throw new Error(`Missing feed cache: ${FEED_CACHE_FILE}`)
    }

    const seen = new Set()
    const parser = fs
        .createReadStream(FEED_CACHE_FILE)
        .pipe(parse({ columns: true, skip_empty_lines: true, relax_column_count: true }))

    for await (const row of parser) {
        const type = String(row[CATEGORY_COLUMN] || '').trim()
        if (type) seen.add(type)
    }

    return [...seen].sort()
}

function writeOutput(typeMap, ourTypes) {
    const ourTypesLower = new Set(ourTypes.map((t) => t.toLowerCase()))
    const outputRows = []
    const sortedKeys = [...typeMap.keys()].sort()

    for (const calculatedType of sortedKeys) {
        const displayType = titleCase(calculatedType)
        const isNew = !ourTypesLower.has(calculatedType.toLowerCase())
        const costwayTypesForKey = typeMap.get(calculatedType)

        for (const costwayType of costwayTypesForKey) {
            outputRows.push({
                'Calculated Type': displayType,
                Status: isNew ? 'New' : 'Merged',
                'Costway Type': costwayType,
            })
        }
    }

    const csvHeaders = ['Calculated Type', 'Status', 'Costway Type']
    const csvLines = [csvHeaders.join(',')]
    for (const row of outputRows) {
        csvLines.push(csvHeaders.map((h) => escapeCsv(row[h])).join(','))
    }

    const csv = csvLines.join('\n')
    fs.writeFileSync('costway_ai_type_merge.csv', csv)
    return csv
}

async function sendResultEmail(csvContent) {
    if (!EMAIL_ENABLED) return

    const boundary = `----boundary_${Date.now().toString(16)}`
    const subject = 'Costway AI Product Type Merge CSV'
    const bodyText = 'Attached is the Costway AI type merge output CSV.'
    const base64Csv = Buffer.from(csvContent, 'utf8').toString('base64')

    const rawMessage = [
        `From: ${EMAIL_FROM}`,
        `To: ${EMAIL_TO}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        '',
        bodyText,
        '',
        `--${boundary}`,
        'Content-Type: text/csv; name="costway_ai_type_merge.csv"',
        'Content-Disposition: attachment; filename="costway_ai_type_merge.csv"',
        'Content-Transfer-Encoding: base64',
        '',
        base64Csv,
        '',
        `--${boundary}--`,
    ].join('\r\n')

    const ses = new SESClient({ region: process.env.AWS_REGION || 'us-east-1' })
    await ses.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(rawMessage) } }))
    console.log(`Emailed CSV to ${EMAIL_TO}`)
}

async function matchBatch(client, costwayTypeBatch, fpTypes) {
    const systemPrompt = `You are a product taxonomy expert for an e-commerce store. Given a list of Costway product type paths (hierarchical, separated by ">"), map each one to the best matching product type from our store's existing type list.

Rules:
- Pick the closest semantic match from our existing types list.
- Costway paths are hierarchical (e.g. "Outdoor > Outdoor Shades > Outdoor Umbrella Bases"). Use full path context.
- If multiple segments match, prefer the most specific match.
- If there is NO reasonable match in our existing list, set mappedType to "NONE".
- Only use "NONE" when genuinely no close equivalent exists.

Respond with JSON only in this shape:
{ "results": [ { "costwayType": "<exact costway type string>", "mappedType": "<our type or NONE>" } ] }`

    const userPrompt = `Our existing product types:
${fpTypes.join('\n')}

Map each Costway product type below to the best matching existing type from our list above (or "NONE"):

${costwayTypeBatch.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Return JSON with a "results" array and one item per Costway type.`

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

    return items
        .map((item) => ({
            costwayType: item.costwayType,
            mappedType: item.mappedType,
        }))
        .filter((item) => item.costwayType)
}

async function main() {
    const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_AI_LISTER_API_KEY
    if (!apiKey) {
        throw new Error('Missing OpenAI API key (OPENAI_API_KEY or OPENAI_AI_LISTER_API_KEY)')
    }

    const pool = createPool()
    const client = new OpenAI({ apiKey, timeout: 120000, maxRetries: 2 })

    try {
        console.log('Loading product types from database...')
        const ourTypes = await getProductTypes(pool)
        console.log(`Loaded ${ourTypes.length} product types from DB`)
        console.log(`Using Costway category column: ${CATEGORY_COLUMN}`)

        console.log('Reading distinct Costway types from cached feed...')
        const costwayTypes = await getDistinctCostwayTypes()
        console.log(`Found ${costwayTypes.length} distinct Costway types`)

        const batches = []
        for (let i = 0; i < costwayTypes.length; i += BATCH_SIZE) {
            batches.push(costwayTypes.slice(i, i + BATCH_SIZE))
        }

        console.log(`Processing ${batches.length} batch(es) of up to ${BATCH_SIZE} types each...`)
        const typeMap = new Map()

        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
            const batch = batches[batchIdx]
            console.log(`Batch ${batchIdx + 1}/${batches.length} (${batch.length} types)...`)

            try {
                const batchResults = await matchBatch(client, batch, ourTypes)

                for (const result of batchResults) {
                    let mappedType = result.mappedType

                    if (!mappedType || mappedType === 'NONE') {
                        const segments = String(result.costwayType)
                            .split('>')
                            .map((s) => s.trim())
                            .filter(Boolean)
                        mappedType = generateNewType(segments[segments.length - 1])
                    }

                    if (!mappedType) continue
                    if (!typeMap.has(mappedType)) typeMap.set(mappedType, [])
                    typeMap.get(mappedType).push(result.costwayType)
                }

                // Safety fallback if model misses any rows in a batch.
                const returned = new Set(batchResults.map((r) => r.costwayType))
                for (const missingType of batch) {
                    if (returned.has(missingType)) continue
                    const segments = missingType
                        .split('>')
                        .map((s) => s.trim())
                        .filter(Boolean)
                    const mappedType = generateNewType(segments[segments.length - 1])
                    if (!mappedType) continue
                    if (!typeMap.has(mappedType)) typeMap.set(mappedType, [])
                    typeMap.get(mappedType).push(missingType)
                }
            } catch (err) {
                console.error(`  -> Error in batch ${batchIdx + 1}: ${err.message}`)

                for (const costwayType of batch) {
                    const segments = costwayType
                        .split('>')
                        .map((s) => s.trim())
                        .filter(Boolean)
                    const mappedType = generateNewType(segments[segments.length - 1])
                    if (!mappedType) continue
                    if (!typeMap.has(mappedType)) typeMap.set(mappedType, [])
                    typeMap.get(mappedType).push(costwayType)
                }
            }

            writeOutput(typeMap, ourTypes)
            if (batchIdx < batches.length - 1) {
                await new Promise((r) => setTimeout(r, 200))
            }
        }

        const finalCsv = writeOutput(typeMap, ourTypes)
        await sendResultEmail(finalCsv)
        console.log('Done! Final output written to costway_ai_type_merge.csv')
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
