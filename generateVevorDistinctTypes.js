import 'dotenv/config'
import fetch from 'node-fetch'
import xlsx from 'xlsx'
import fs from 'fs'
import mysql from 'mysql'

const VEVOR_ENDPOINT = process.env.VEVOR_ENDPOINT
const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

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

    // Exact match
    const exactIdx = ourTypesLower.indexOf(sl)
    if (exactIdx !== -1) return ourTypes[exactIdx]

    // Plural match (add 's')
    const pluralIdx = ourTypesLower.indexOf(sl + 's')
    if (pluralIdx !== -1) return ourTypes[pluralIdx]

    // Singular match (remove trailing 's')
    if (sl.endsWith('s')) {
        const singularIdx = ourTypesLower.indexOf(sl.slice(0, -1))
        if (singularIdx !== -1) return ourTypes[singularIdx]
    }

    return null
}

async function main() {
    const res = await fetch(VEVOR_ENDPOINT)
    const buffer = await res.arrayBuffer()
    const workbook = xlsx.read(Buffer.from(buffer))
    const rows = xlsx.utils.sheet_to_json(workbook.Sheets.feed)

    const pool = mysql.createPool({
        connectionLimit: 5,
        host: DB_WRITE_HOST,
        user: DB_USER,
        password: DB_PASSWORD,
        port: 3306,
        database: 'main',
        timezone: '+00:00',
    })

    const existingTypes = await query(
        pool,
        `SELECT DISTINCT product_type FROM products WHERE product_type IS NOT NULL AND product_type != '' ORDER BY product_type`
    )
    const ourTypes = existingTypes.map((r) => r.product_type)
    const ourTypesLower = ourTypes.map((t) => t.toLowerCase())
    console.log(`Loaded ${ourTypes.length} product types from DB`)

    // Map: mapped type -> { isNew, count }
    const resultMap = new Map()
    // SKU-level rows for sheet 1
    const skuRows = []

    for (const row of rows) {
        const fullType = (row['Product type'] || '').trim()
        if (!fullType) continue
        const segments = fullType
            .split('>')
            .map((s) => s.trim().replace(/\s+/g, ' '))
            .filter(Boolean)

        let mapped = null
        let isNew = false

        // Traverse forwards (left to right), stop at first match
        for (const segment of segments) {
            const match = matchType(segment, ourTypes, ourTypesLower)
            if (match) {
                mapped = match
                break
            }
        }

        // No match at any level - create new type from last segment
        if (!mapped) {
            let lastSegment = segments[segments.length - 1]
            // Strip leading adjectives that don't belong in product types
            const stripPrefixes = ['Commercial', 'Inflatable', 'Automatic', 'Manual']
            for (const prefix of stripPrefixes) {
                if (lastSegment.startsWith(prefix + ' ')) {
                    lastSegment = lastSegment.slice(prefix.length + 1)
                    break
                }
            }
            // Re-check for match after stripping prefix
            const strippedMatch = matchType(lastSegment, ourTypes, ourTypesLower)
            if (strippedMatch) {
                mapped = strippedMatch
            } else {
                mapped =
                    lastSegment.endsWith('s') || lastSegment.endsWith('ry') || lastSegment.endsWith('ing')
                        ? lastSegment
                        : lastSegment + 's'
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
            SKU: (row['SKU'] || '').trim(),
            Title: (row['Product title'] || '').trim(),
            'Vevor Product Type': fullType,
            'Mapped Product Type': mapped,
        })
    }

    const sorted = [...resultMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))

    // CSV 1: SKU mapping
    const skuCsvLines = ['SKU,Title,Vevor Product Type,Mapped Product Type']
    for (const row of skuRows) {
        skuCsvLines.push(
            [row.SKU, row.Title, row['Vevor Product Type'], row['Mapped Product Type']].map(escapeCsv).join(',')
        )
    }
    fs.writeFileSync('vevor_sku_type_mapping.csv', skuCsvLines.join('\n'))
    console.log(`Written vevor_sku_type_mapping.csv (${skuRows.length} rows)`)

    // CSV 2: Distinct types
    const typeCsvLines = ['Type,New,Product Count']
    for (const [type, { isNew, count }] of sorted) {
        typeCsvLines.push(`${escapeCsv(type)},${isNew ? 'Yes' : 'No'},${count}`)
    }
    fs.writeFileSync('vevor_distinct_types.csv', typeCsvLines.join('\n'))
    console.log(`Written vevor_distinct_types.csv (${sorted.length} rows)`)

    pool.end()
}

function escapeCsv(val) {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`
    }
    return val
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
