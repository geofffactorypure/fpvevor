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

async function main() {
    // 1. Fetch Vevor feed
    console.log('Fetching Vevor feed...')
    const res = await fetch(VEVOR_ENDPOINT)
    const buffer = await res.arrayBuffer()
    const workbook = xlsx.read(Buffer.from(buffer))
    const sheet = workbook.Sheets.feed
    const rows = xlsx.utils.sheet_to_json(sheet)
    console.log(`Feed has ${rows.length} rows`)

    // 2. Extract distinct Vevor product types (last segment of the hierarchy)
    const vevorTypeMap = new Map() // lastSegment -> full path
    for (const row of rows) {
        const fullType = (row['Product type'] || '').trim()
        if (!fullType) continue
        const segments = fullType.split('>').map((s) => s.trim())
        const lastSegment = segments[segments.length - 1]
        if (lastSegment && !vevorTypeMap.has(lastSegment)) {
            vevorTypeMap.set(lastSegment, fullType)
        }
    }
    console.log(`\nFound ${vevorTypeMap.size} distinct Vevor product types (leaf level)`)

    // 3. Get our existing product types from the database
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
    console.log(`Loaded ${ourTypes.length} distinct product types from DB`)

    // 4. Map Vevor types to our types
    const ourTypesLower = ourTypes.map((t) => t.toLowerCase())
    const typeMapping = new Map() // vevor leaf type -> our mapped type

    for (const [vevorLeaf] of vevorTypeMap) {
        const vevorLower = vevorLeaf.toLowerCase()

        // Try exact match first
        const exactIdx = ourTypesLower.indexOf(vevorLower)
        if (exactIdx !== -1) {
            typeMapping.set(vevorLeaf, ourTypes[exactIdx])
            continue
        }

        // Try plural match (add 's')
        const pluralIdx = ourTypesLower.indexOf(vevorLower + 's')
        if (pluralIdx !== -1) {
            typeMapping.set(vevorLeaf, ourTypes[pluralIdx])
            continue
        }

        // Try singular match (remove trailing 's')
        if (vevorLower.endsWith('s')) {
            const singularIdx = ourTypesLower.indexOf(vevorLower.slice(0, -1))
            if (singularIdx !== -1) {
                typeMapping.set(vevorLeaf, ourTypes[singularIdx])
                continue
            }
        }

        // Try contains match
        const containsIdx = ourTypesLower.findIndex((t) => t.includes(vevorLower) || vevorLower.includes(t))
        if (containsIdx !== -1) {
            typeMapping.set(vevorLeaf, ourTypes[containsIdx])
            continue
        }

        // No match - create new type following our convention (plural)
        const newType =
            vevorLeaf.endsWith('s') || vevorLeaf.endsWith('ry') || vevorLeaf.endsWith('ing')
                ? vevorLeaf
                : vevorLeaf + 's'
        typeMapping.set(vevorLeaf, `[NEW] ${newType}`)
    }

    // 5. Print type mapping summary
    console.log('\n--- PRODUCT TYPE MAPPING ---')
    console.log('Vevor Type (leaf) -> Our Type')
    console.log('='.repeat(80))
    const sortedMapping = [...typeMapping.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    for (const [vevorType, ourType] of sortedMapping) {
        const marker = ourType.startsWith('[NEW]') ? ' ** NEW **' : ''
        console.log(`  ${vevorType} -> ${ourType}${marker}`)
    }

    // 6. Generate CSV: SKU, Title, Vevor Product Type (full), Vevor Product Type (leaf), Mapped Type
    const csvRows = [
        ['SKU', 'Title', 'Vevor Product Type (Full Path)', 'Vevor Product Type (Leaf)', 'Mapped Product Type'],
    ]
    for (const row of rows) {
        const sku = (row['SKU'] || '').trim()
        const title = (row['Product title'] || '').trim()
        const fullType = (row['Product type'] || '').trim()
        const segments = fullType.split('>').map((s) => s.trim())
        const lastSegment = segments[segments.length - 1]
        const mappedType = typeMapping.get(lastSegment) || ''
        csvRows.push([sku, title, fullType, lastSegment, mappedType])
    }

    // Escape CSV values
    const escapeCsv = (val) => {
        if (val.includes(',') || val.includes('"') || val.includes('\n')) {
            return `"${val.replace(/"/g, '""')}"`
        }
        return val
    }

    const csvContent = csvRows.map((row) => row.map(escapeCsv).join(',')).join('\n')
    fs.writeFileSync('vevor_product_types_audit.csv', csvContent)
    console.log(`\nCSV written to vevor_product_types_audit.csv (${csvRows.length - 1} data rows)`)

    // 7. Summary stats
    const newTypes = sortedMapping.filter(([, t]) => t.startsWith('[NEW]'))
    const matchedTypes = sortedMapping.filter(([, t]) => !t.startsWith('[NEW]'))
    console.log(`\n--- SUMMARY ---`)
    console.log(`Total distinct Vevor leaf types: ${vevorTypeMap.size}`)
    console.log(`Matched to existing types: ${matchedTypes.length}`)
    console.log(`New types needed: ${newTypes.length}`)

    pool.end()
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
