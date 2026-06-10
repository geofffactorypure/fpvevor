import 'dotenv/config'
import fetch from 'node-fetch'
import xlsx from 'xlsx'
import fs from 'fs'

const res = await fetch(process.env.VEVOR_ENDPOINT)
const buffer = await res.arrayBuffer()
const workbook = xlsx.read(Buffer.from(buffer))
const rows = xlsx.utils.sheet_to_json(workbook.Sheets.feed)

const typeCounts = new Map()
for (const row of rows) {
    const fullType = (row['Product type'] || '').trim()
    if (!fullType) continue
    const segments = fullType.split('>').map((s) => s.trim())
    const last = segments[segments.length - 1]
    if (last) typeCounts.set(last, (typeCounts.get(last) || 0) + 1)
}

const sorted = [...typeCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))

const escapeCsv = (val) =>
    val.includes(',') || val.includes('"') || val.includes('\n') ? `"${val.replace(/"/g, '""')}"` : val

const csvLines = ['Type,Product Count', ...sorted.map(([type, count]) => `${escapeCsv(type)},${count}`)]
fs.writeFileSync('vevor_leaf_types.csv', csvLines.join('\n'))
console.log(`Written ${sorted.length} rows to vevor_leaf_types.csv`)
