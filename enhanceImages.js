import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import OpenAI from 'openai'
import { parse } from 'csv-parse/sync'

const openai = new OpenAI({ apiKey: process.env.OPENAI_AI_LISTER_API_KEY })

const OUTPUT_DIR = './enhanced_images'
const TEST_LIMIT = parseInt(process.argv[2]) || 10

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
}

// Read the results CSV and get BAD + OK entries
const input = fs.readFileSync('image_quality_audit.csv', 'utf-8')
const records = parse(input, { columns: true, skip_empty_lines: true })

// Filter to BAD quality (lap < 50) — prioritize the worst ones, skip logos
const badImages = records
    .filter((r) => {
        const lap = parseFloat(r.lapVariance)
        const ws = parseFloat(r.whitespacePct)
        const w = parseInt(r.width)
        const h = parseInt(r.height)
        // Skip tiny images (likely logos) and errors
        if (lap < 0 || w < 200 || h < 200) return false
        return lap < 50 || ws > 30
    })
    .filter((r) => !r.imageUrl.includes('logo')) // skip logo images
    .sort((a, b) => parseFloat(a.lapVariance) - parseFloat(b.lapVariance))

console.log(`Found ${badImages.length} bad/ok images total`)
console.log(`Processing first ${TEST_LIMIT} for testing...\n`)

const testBatch = badImages.slice(0, TEST_LIMIT)

async function enhanceImage(record) {
    const { handle, title } = record
    const imageUrl = record.imageUrl.split('?')[0] + '?width=1500'

    console.log(`Processing: ${handle}`)
    console.log(`  Source: ${imageUrl}`)

    try {
        // Download the original image
        const imgRes = await fetch(imageUrl)
        if (!imgRes.ok) throw new Error(`Failed to download: HTTP ${imgRes.status}`)
        const imgBuffer = Buffer.from(await imgRes.arrayBuffer())

        // Save original for comparison
        const ext = imageUrl.match(/\.(png|jpg|jpeg|webp)/i)?.[1] || 'png'
        const origPath = path.join(OUTPUT_DIR, `${handle}_original.${ext}`)
        fs.writeFileSync(origPath, imgBuffer)

        // Resize to fit within OpenAI's limits and compress
        const { default: sharp } = await import('sharp')
        const resizedBuffer = await sharp(imgBuffer)
            .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
            .png({ compressionLevel: 9 })
            .toBuffer()

        // Write to temp file for OpenAI API
        const tempPath = path.join(OUTPUT_DIR, `_temp_${handle}.png`)
        fs.writeFileSync(tempPath, resizedBuffer)

        // Use OpenAI gpt-image-1 to enhance
        const response = await openai.images.edit({
            model: 'gpt-image-1',
            image: new File([resizedBuffer], `${handle}.png`, { type: 'image/png' }),
            prompt: `Enhance this product photo to be higher quality and sharper. Make it look professional for an e-commerce product listing. Keep the product exactly the same - do not change, add, or remove any objects. Only improve clarity, sharpness, lighting, and remove any compression artifacts. If there is excessive whitespace/transparent padding, crop it to show the product filling the frame better.`,
            size: '1024x1024',
        })

        // Clean up temp file
        fs.unlinkSync(tempPath)

        // gpt-image-1 returns base64
        const base64 = response.data[0].b64_json
        const enhancedBuffer = Buffer.from(base64, 'base64')
        const enhancedPath = path.join(OUTPUT_DIR, `${handle}_enhanced.png`)
        fs.writeFileSync(enhancedPath, enhancedBuffer)

        console.log(`  ✓ Saved: ${enhancedPath}`)
        return { handle, success: true, enhancedPath }
    } catch (err) {
        console.log(`  ✗ Error: ${err.message}`)
        return { handle, success: false, error: err.message }
    }
}

console.log('─'.repeat(50))

const results = []
for (const record of testBatch) {
    const result = await enhanceImage(record)
    results.push(result)
    console.log('')
}

console.log('─'.repeat(50))
console.log(`\nDone! ${results.filter((r) => r.success).length}/${TEST_LIMIT} enhanced successfully.`)
console.log(`\nOriginals and enhanced versions saved to: ${OUTPUT_DIR}/`)
console.log('Compare side-by-side to evaluate quality improvement.')
