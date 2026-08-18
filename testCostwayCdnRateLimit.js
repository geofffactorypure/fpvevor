/**
 * testCostwayCdnRateLimit.js
 *
 * Fires batches of HEAD/GET requests against Costway CDN image URLs
 * to check for rate limiting behaviour.
 *
 * Usage:
 *   node testCostwayCdnRateLimit.js [concurrency] [rounds]
 *
 * Pulls sample image URLs from a real S3 product entry so the URLs are live.
 * Falls back to a hardcoded URL list if S3 fetch fails.
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import 'dotenv/config'

const CONCURRENCY = parseInt(process.argv[2]) || 5
const ROUNDS      = parseInt(process.argv[3]) || 3
const DELAY_MS    = 500   // pause between rounds

const S3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' })

async function getS3Json(key) {
    try {
        const res = await S3.send(new GetObjectCommand({ Bucket: 'fpdash-bucket', Key: key }))
        const body = await res.Body.transformToString()
        return JSON.parse(body)
    } catch {
        return null
    }
}

// mode: 'head' | 'get'
const MODE = process.argv[4] || 'head'

async function fetchHead(url, idx) {
    const start = Date.now()
    try {
        const res = await fetch(url, {
            method: MODE === 'get' ? 'GET' : 'HEAD',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(8000),
        })
        let bytes = 0
        if (MODE === 'get') {
            const buf = await res.arrayBuffer()
            bytes = buf.byteLength
        }
        const elapsed = Date.now() - start
        const kb = bytes ? ` ${(bytes / 1024).toFixed(0)}KB` : ''
        return { idx, url, status: res.status, elapsed, ok: res.ok, note: kb }
    } catch (err) {
        const elapsed = Date.now() - start
        return { idx, url, status: 'ERR', elapsed, ok: false, note: err.message }
    }
}

async function runRound(urls, roundNum) {
    console.log(`\n── Round ${roundNum} (${urls.length} URLs, concurrency ${CONCURRENCY}) ──`)
    let pass = 0, fail = 0, rateLimited = 0
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
        const chunk = urls.slice(i, i + CONCURRENCY)
        const results = await Promise.all(chunk.map((u, j) => fetchHead(u, i + j + 1)))
        for (const r of results) {
            const icon = r.status === 200 ? '✓' : r.status === 429 ? '⛔' : '✗'
        console.log(`  ${icon} [${r.idx}] ${r.status} ${r.elapsed}ms${r.note || ''} — ${r.url.slice(0, 80)}`)
            if (r.status === 200) pass++
            else if (r.status === 429) rateLimited++
            else fail++
        }
    }
    console.log(`  → ${pass} OK, ${fail} fail, ${rateLimited} rate-limited (429)`)
    return { pass, fail, rateLimited }
}

async function main() {
    console.log('Costway CDN Rate Limit Test')
    console.log(`Mode: ${MODE.toUpperCase()}, Concurrency: ${CONCURRENCY}, Rounds: ${ROUNDS}\n`)

    // Try to pull live image URLs from S3 parent batch 0
    let imageUrls = []
    console.log('Fetching sample product data from S3...')
    const batch = await getS3Json('costwaydata/configurableParents/0')
    if (batch) {
        const parentIds = Object.keys(batch).slice(0, 20)
        for (const id of parentIds) {
            const entry = batch[id]
            const opts = entry.options || []
            for (const opt of opts.slice(0, 2)) {
                // Use variant S3 data if we can find an image URL pattern
                // Fall back to checking parent entry directly
            }
            // Get parent S3 data for gallery
            const productData = await getS3Json(`costwaydata/${id}`)
            if (productData) {
                const gallery = productData.relation?.[0]?.gallery || productData.gallery || []
                for (const img of gallery.slice(0, 3)) {
                    if (img.original_image) imageUrls.push(img.original_image)
                }
            }
            if (imageUrls.length >= 30) break
        }
    }

    if (imageUrls.length === 0) {
        console.log('Could not load URLs from S3, using fallback hardcoded Costway CDN URL pattern')
        // Replace with any known live Costway image URL
        console.log('ERROR: No URLs available. Pass actual Costway image URLs or ensure S3 access.')
        process.exit(1)
    }

    console.log(`Got ${imageUrls.length} image URLs from S3\n`)

    // Deduplicate
    imageUrls = [...new Set(imageUrls)]

    const totals = { pass: 0, fail: 0, rateLimited: 0 }

    for (let r = 1; r <= ROUNDS; r++) {
        const result = await runRound(imageUrls, r)
        totals.pass += result.pass
        totals.fail += result.fail
        totals.rateLimited += result.rateLimited

        if (r < ROUNDS) {
            console.log(`  Waiting ${DELAY_MS}ms before next round...`)
            await new Promise((res) => setTimeout(res, DELAY_MS))
        }
    }

    console.log('\n══ Summary ══')
    console.log(`Total requests: ${ROUNDS * imageUrls.length}`)
    console.log(`  ✓ OK:           ${totals.pass}`)
    console.log(`  ✗ Other fail:   ${totals.fail}`)
    console.log(`  ⛔ Rate limited: ${totals.rateLimited}`)

    if (totals.rateLimited > 0) {
        console.log('\n⚠️  CDN rate limiting detected!')
        console.log('Recommendations:')
        console.log('  1. Add a small delay between requests in filterSmallImages')
        console.log('  2. Reduce CONCURRENCY setting when listing multiple products')
        console.log('  3. Use HEAD requests instead of GET in filterSmallImages (saves bandwidth)')
    } else if (totals.fail > 0) {
        console.log('\n⚠️  Some requests failed (non-429). May be transient errors or IP blocks.')
    } else {
        console.log('\n✓ No rate limiting detected at this concurrency level.')
    }
}

main().catch((err) => {
    console.error('Fatal:', err)
    process.exit(1)
})
