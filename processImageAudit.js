import fs from 'fs'
import { parse } from 'csv-parse/sync'

const input = fs.readFileSync('image_quality_audit.csv', 'utf-8')
const records = parse(input, { columns: true, skip_empty_lines: true })

const output = [['title', 'url', 'score', 'reason'].join(',')]

for (const row of records) {
    const lap = parseFloat(row.lapVariance)
    const ws = parseFloat(row.whitespacePct)
    const grad = parseFloat(row.gradEnergy)

    const reasons = []
    let score = 'GOOD'

    if (lap < 0) {
        score = 'ERROR'
        reasons.push('failed to process')
    } else {
        if (lap < 50) {
            score = 'BAD'
            reasons.push('low sharpness')
        } else if (lap < 200) {
            score = 'OK'
            reasons.push('moderate sharpness')
        }

        if (ws > 30) {
            if (score === 'GOOD') score = 'BAD'
            reasons.push('excessive whitespace')
        } else if (ws > 15) {
            if (score === 'GOOD') score = 'OK'
            reasons.push('some whitespace')
        }

        if (grad < 50) {
            if (score === 'GOOD') score = 'OK'
            reasons.push('weak edges')
        }
    }

    const title = `"${(row.title || '').replace(/"/g, '""')}"`
    const url = `https://factorypure.com/products/${row.handle}`
    const reason = reasons.length ? reasons.join('; ') : 'good quality'

    output.push(`${title},${url},${score},${reason}`)
}

fs.writeFileSync('image_quality_results.csv', output.join('\n'))

const counts = { GOOD: 0, OK: 0, BAD: 0, ERROR: 0 }
for (const line of output.slice(1)) {
    const score = line.split(',')[2]
    counts[score] = (counts[score] || 0) + 1
}

console.log(`Processed ${records.length} products → image_quality_results.csv`)
console.log(`  GOOD: ${counts.GOOD}`)
console.log(`  OK:   ${counts.OK}`)
console.log(`  BAD:  ${counts.BAD}`)
console.log(`  ERROR: ${counts.ERROR}`)
