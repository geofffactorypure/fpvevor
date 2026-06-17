import fs from 'fs'

function parseCsvLine(line) {
    const fields = []
    let current = ''
    let inQuotes = false

    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') {
            inQuotes = !inQuotes
        } else if (ch === ',' && !inQuotes) {
            fields.push(current.trim())
            current = ''
        } else {
            current += ch
        }
    }
    fields.push(current.trim())
    return fields
}

function escapeCsv(val) {
    const str = String(val ?? '')
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`
    }
    return str
}

const MERGE_FILE = 'costway_ai_type_merge.csv'
const SKU_MAP_FILE = 'costway_sku_type_mapping.csv'

if (!fs.existsSync(MERGE_FILE)) {
    throw new Error(`Missing ${MERGE_FILE}`)
}
if (!fs.existsSync(SKU_MAP_FILE)) {
    throw new Error(`Missing ${SKU_MAP_FILE}`)
}

// 1) Build Costway Type -> Calculated Type map from AI output.
const mergeLines = fs.readFileSync(MERGE_FILE, 'utf8').split('\n').filter(Boolean)
const costwayTypeMap = new Map()

for (let i = 1; i < mergeLines.length; i++) {
    const fields = parseCsvLine(mergeLines[i])
    const calculatedType = fields[0]
    const costwayType = fields[2]
    if (!costwayType || !calculatedType) continue
    costwayTypeMap.set(costwayType, calculatedType)
}

console.log(`Loaded ${costwayTypeMap.size} Costway type mappings from ${MERGE_FILE}`)

// 2) Rewrite SKU map using AI mapping.
const skuLines = fs.readFileSync(SKU_MAP_FILE, 'utf8').split('\n').filter(Boolean)
if (!skuLines.length) throw new Error(`${SKU_MAP_FILE} is empty`)

const updatedSkuLines = [skuLines[0]]
let matched = 0
let unmatched = 0

for (let i = 1; i < skuLines.length; i++) {
    const fields = parseCsvLine(skuLines[i])
    const costwayType = fields[2]

    if (!costwayType) {
        updatedSkuLines.push(skuLines[i])
        continue
    }

    const mappedType = costwayTypeMap.get(costwayType)
    if (mappedType) {
        matched++
        fields[3] = mappedType
        updatedSkuLines.push(fields.map(escapeCsv).join(','))
    } else {
        unmatched++
        updatedSkuLines.push(skuLines[i])
    }
}

fs.writeFileSync(SKU_MAP_FILE, updatedSkuLines.join('\n'))
console.log(`Updated ${SKU_MAP_FILE} (${updatedSkuLines.length - 1} rows)`)
console.log(`Rows matched: ${matched}, unmatched: ${unmatched}`)
