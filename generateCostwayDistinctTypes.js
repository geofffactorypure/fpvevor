import 'dotenv/config'
import fs from 'fs'
import mysql from 'mysql'
import { parse } from 'csv-parse'
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'

const FEED_CACHE_FILE = './costway_data/feed_cache.csv'
const CATEGORY_COLUMN = process.env.COSTWAY_CATEGORY_COLUMN || process.argv[2] || 'Category'
const EMAIL_TO = process.env.COSTWAY_TYPE_EMAIL_TO || 'gjarman@factorypure.com'
const EMAIL_FROM = process.env.COSTWAY_TYPE_EMAIL_FROM || 'gjarman@factorypure.com'
const EMAIL_ENABLED = (process.env.COSTWAY_TYPE_EMAIL_ENABLED || 'true').toLowerCase() !== 'false'

function query(pool, sql) {
    return new Promise((resolve, reject) => {
        pool.query(sql, (err, results) => {
            if (err) return reject(err)
            resolve(results)
        })
    })
}

function matchType(segment, ourTypes, ourTypesLower) {
    const sl = segment.toLowerCase().trim()

    const exactIdx = ourTypesLower.indexOf(sl)
    if (exactIdx !== -1) return ourTypes[exactIdx]

    const pluralIdx = ourTypesLower.indexOf(sl + 's')
    if (pluralIdx !== -1) return ourTypes[pluralIdx]

    if (sl.endsWith('s')) {
        const singularIdx = ourTypesLower.indexOf(sl.slice(0, -1))
        if (singularIdx !== -1) return ourTypes[singularIdx]
    }

    return null
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

async function readCostwayRows(filePath, onRow) {
    const parser = fs
        .createReadStream(filePath)
        .pipe(parse({ columns: true, skip_empty_lines: true, relax_column_count: true }))

    for await (const row of parser) {
        await onRow(row)
    }
}

function buildAttachmentPart(boundary, filename, content) {
    const base64 = Buffer.from(content, 'utf8').toString('base64')
    return [
        `--${boundary}`,
        `Content-Type: text/csv; name="${filename}"`,
        `Content-Disposition: attachment; filename="${filename}"`,
        'Content-Transfer-Encoding: base64',
        '',
        base64,
        '',
    ].join('\r\n')
}

async function sendSummaryEmail({ totalRows, usedRows, skuCount, distinctCount, skuCsv, typeCsv }) {
    if (!EMAIL_ENABLED) return

    const boundary = `----boundary_${Date.now().toString(16)}`
    const subject = 'Costway Product Type Mapping CSVs'

    const bodyText = [
        'Attached are the Costway product type mapping outputs.',
        '',
        `Rows scanned: ${totalRows}`,
        `Rows with category data: ${usedRows}`,
        `SKU mappings: ${skuCount}`,
        `Distinct mapped types: ${distinctCount}`,
    ].join('\n')

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
        buildAttachmentPart(boundary, 'costway_sku_type_mapping.csv', skuCsv),
        buildAttachmentPart(boundary, 'costway_distinct_types.csv', typeCsv),
        `--${boundary}--`,
    ].join('\r\n')

    const ses = new SESClient({ region: process.env.AWS_REGION || 'us-east-1' })
    await ses.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(rawMessage) } }))
    console.log(`Emailed CSVs to ${EMAIL_TO}`)
}

async function main() {
    const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env
    if (!DB_PASSWORD || !DB_WRITE_HOST || !DB_USER) {
        throw new Error('Missing DB credentials: DB_WRITE_HOST, DB_USER, DB_PASSWORD')
    }

    if (!fs.existsSync(FEED_CACHE_FILE)) {
        throw new Error(`Missing feed cache: ${FEED_CACHE_FILE}`)
    }

    const pool = mysql.createPool({
        connectionLimit: 5,
        host: DB_WRITE_HOST,
        user: DB_USER,
        password: DB_PASSWORD,
        port: 3306,
        database: 'main',
        timezone: '+00:00',
    })

    try {
        const existingTypes = await query(
            pool,
            `SELECT DISTINCT product_type FROM products WHERE product_type IS NOT NULL AND product_type != '' ORDER BY product_type`
        )
        const ourTypes = existingTypes.map((r) => r.product_type)
        const ourTypesLower = ourTypes.map((t) => t.toLowerCase())
        console.log(`Loaded ${ourTypes.length} product types from DB`)
        console.log(`Using Costway category column: ${CATEGORY_COLUMN}`)

        const resultMap = new Map()
        const skuRows = []
        let totalRows = 0
        let usedRows = 0

        await readCostwayRows(FEED_CACHE_FILE, async (row) => {
            totalRows++

            const fullType = (row[CATEGORY_COLUMN] || '').trim()
            if (!fullType) return
            usedRows++

            const segments = fullType
                .split('>')
                .map((s) => s.trim().replace(/\s+/g, ' '))
                .filter(Boolean)
            if (!segments.length) return

            let mapped = null
            let isNew = false

            for (const segment of segments) {
                const match = matchType(segment, ourTypes, ourTypesLower)
                if (match) {
                    mapped = match
                    break
                }
            }

            if (!mapped) {
                const fallback = generateNewType(segments[segments.length - 1])
                if (!fallback) return

                const strippedMatch = matchType(fallback, ourTypes, ourTypesLower)
                if (strippedMatch) {
                    mapped = strippedMatch
                } else {
                    mapped = fallback
                    isNew = true
                }
            }

            const existing = resultMap.get(mapped)
            if (existing) {
                existing.count++
            } else {
                resultMap.set(mapped, { isNew, count: 1 })
            }

            skuRows.push({
                SKU: String(row['Variant SKU'] || '').trim(),
                Title: String(row['Title'] || '').trim(),
                'Costway Product Type': fullType,
                'Mapped Product Type': mapped,
            })
        })

        const sorted = [...resultMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))

        const skuCsvLines = ['SKU,Title,Costway Product Type,Mapped Product Type']
        for (const row of skuRows) {
            skuCsvLines.push(
                [row.SKU, row.Title, row['Costway Product Type'], row['Mapped Product Type']].map(escapeCsv).join(',')
            )
        }
        const skuCsv = skuCsvLines.join('\n')
        fs.writeFileSync('costway_sku_type_mapping.csv', skuCsv)

        const typeCsvLines = ['Type,New,Product Count']
        for (const [type, { isNew, count }] of sorted) {
            typeCsvLines.push(`${escapeCsv(type)},${isNew ? 'Yes' : 'No'},${count}`)
        }
        const typeCsv = typeCsvLines.join('\n')
        fs.writeFileSync('costway_distinct_types.csv', typeCsv)

        console.log(`Feed rows scanned: ${totalRows}`)
        console.log(`Rows with '${CATEGORY_COLUMN}': ${usedRows}`)
        console.log(`Written costway_sku_type_mapping.csv (${skuRows.length} rows)`)
        console.log(`Written costway_distinct_types.csv (${sorted.length} rows)`)

        await sendSummaryEmail({
            totalRows,
            usedRows,
            skuCount: skuRows.length,
            distinctCount: sorted.length,
            skuCsv,
            typeCsv,
        })
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
