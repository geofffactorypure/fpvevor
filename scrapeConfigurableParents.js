import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import { S3 as AWSS3, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'

// ── Config ──────────────────────────────────────────────────────────────────
const START_ID = parseInt(process.argv[2]) || 1
const END_ID = parseInt(process.argv[3]) || 100000
const DELAY_MS = parseInt(process.argv[4]) || 250 // only applied to live API calls
const MAX_RETRIES = 5
const SAVE_EVERY = 200 // checkpoint progress to S3 every N IDs

const S3_BUCKET = 'fpdash-bucket'
const S3_PRODUCT_PREFIX = 'costwaydata'
const S3_PARENTS_PREFIX = 'costwaydata/configurableParents'
const S3_PROGRESS_KEY = 'costwaydata/configurableParentsProgress'
const SEGMENT_SIZE = 1000

const S3 = new AWSS3({ region: process.env.AWS_REGION || 'us-east-1' })

// ── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getSegmentKey(id) {
    const segStart = Math.floor((id - 1) / SEGMENT_SIZE) * SEGMENT_SIZE + 1
    const segEnd = segStart + SEGMENT_SIZE - 1
    return `${S3_PARENTS_PREFIX}/${segStart}-${segEnd}`
}

async function getS3Json(key) {
    try {
        const res = await S3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }))
        const body = await res.Body.transformToString()
        return JSON.parse(body)
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404 || err.Code === 'NoSuchKey') return null
        throw err
    }
}

async function putS3Json(key, value) {
    await S3.send(
        new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: key,
            Body: JSON.stringify(value),
            ContentType: 'application/json',
        })
    )
}

async function fetchFromAPI(id, retries = MAX_RETRIES) {
    const url = `https://www.costway.com/api/product/${id}`

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
                    Accept: 'application/json',
                },
            })

            if (res.status === 429) {
                const waitMs = Math.min(60000, Math.pow(2, attempt) * 1000)
                console.error(`  ⏳ ${id}: 429, waiting ${waitMs}ms (attempt ${attempt}/${retries})`)
                await sleep(waitMs)
                continue
            }

            if (!res.ok) return { ok: false, status: res.status, result: null }

            const payload = await res.json()
            const result = payload?.result ?? null
            if (!result) return { ok: false, status: 204, result: null }
            return { ok: true, status: res.status, result }
        } catch (err) {
            if (attempt < retries) {
                await sleep(attempt * 1000)
                continue
            }
            return { ok: false, status: 0, result: null, error: err.message }
        }
    }

    return { ok: false, status: 429, result: null }
}

function buildParentEntry(result) {
    return {
        associatedProducts: (result.pdp_associated_products || []).map((p) => p.product_id),
        options:
            result.relation?.map((p) => ({
                product_id: p.product_id,
                parent_id: p.parent_id,
                image: p.image,
                sku: p.sku,
                special_price: p.special_price,
                old_special_price: p.old_special_price,
                piid: p.piid,
                option: p.option,
                instructions_pdf: 'https://cdn1.costway.com/PDF/instructions/728916543.pdf',
                price: p.price,
                images: p.images,
            })) ?? null,
    }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    console.log('Loading progress from S3…')
    let progress = (await getS3Json(S3_PROGRESS_KEY)) ?? { lastProcessedId: START_ID - 1, configurableCount: 0 }

    const resumeFrom = Math.max(START_ID, (progress.lastProcessedId ?? START_ID - 1) + 1)
    let configurableCount = progress.configurableCount || 0
    let checkedCount = 0

    let currentSegmentKey = getSegmentKey(resumeFrom)
    let currentSegment = (await getS3Json(currentSegmentKey)) ?? {}

    console.log(`Resuming from ID ${resumeFrom} → ${END_ID}`)
    console.log(`Configurable parents so far: ${configurableCount}`)
    console.log(`Current segment: ${currentSegmentKey}`)

    for (let id = resumeFrom; id <= END_ID; id++) {
        checkedCount++

        // ── Segment boundary: flush current segment and load next ───────────
        const segKey = getSegmentKey(id)
        if (segKey !== currentSegmentKey) {
            await putS3Json(currentSegmentKey, currentSegment)
            currentSegmentKey = segKey
            currentSegment = (await getS3Json(currentSegmentKey)) ?? {}
            console.log(`  📦 segment: ${currentSegmentKey}`)
        }

        // ── Step 1: check S3 cache ──────────────────────────────────────────
        const cached = await getS3Json(`${S3_PRODUCT_PREFIX}/${id}`)

        if (cached !== null) {
            // Product already in S3
            if (cached.type_id === 'configurable') {
                currentSegment[id] = buildParentEntry(cached)
                configurableCount++
                await putS3Json(currentSegmentKey, currentSegment)
                progress.lastProcessedId = id
                progress.configurableCount = configurableCount
                await putS3Json(S3_PROGRESS_KEY, progress)
                console.log(
                    `  ✓ ${id} (S3 cache, configurable) → ${currentSegment[id].associatedProducts.length} associated`
                )
            }
            // else: exists but not configurable → skip, no log noise
        } else {
            // ── Step 2: not in S3, hit the live API ────────────────────────
            const res = await fetchFromAPI(id)

            if (res.ok && res.result) {
                if (res.result.type_id === 'configurable') {
                    // Store raw product in S3 for future use
                    await putS3Json(`${S3_PRODUCT_PREFIX}/${id}`, res.result)
                    currentSegment[id] = buildParentEntry(res.result)
                    configurableCount++
                    await putS3Json(currentSegmentKey, currentSegment)
                    progress.lastProcessedId = id
                    progress.configurableCount = configurableCount
                    await putS3Json(S3_PROGRESS_KEY, progress)
                    console.log(
                        `  ✓ ${id} (API, configurable, stored) → ${currentSegment[id].associatedProducts.length} associated`
                    )
                }
                // else: simple product, not in S3, ignore
            } else if (res.status === 429) {
                console.error(`  ✗ ${id}: failed after retries (429)`)
            } else if (res.status !== 404 && res.status !== 204 && res.status !== 200) {
                console.error(`  ✗ ${id}: status ${res.status}${res.error ? ` (${res.error})` : ''}`)
            }

            await sleep(DELAY_MS)
        }

        // ── Checkpoint progress every SAVE_EVERY IDs ───────────────────────
        if (checkedCount % SAVE_EVERY === 0) {
            progress.lastProcessedId = id
            progress.configurableCount = configurableCount
            await putS3Json(S3_PROGRESS_KEY, progress)
            console.log(`  💾 checkpoint @ ${id} (${configurableCount} configurables so far)`)
        }
    }

    // Final save
    await putS3Json(currentSegmentKey, currentSegment)
    progress.lastProcessedId = END_ID
    progress.configurableCount = configurableCount
    await putS3Json(S3_PROGRESS_KEY, progress)

    console.log('\nDone.')
    console.log(`IDs checked         : ${checkedCount}`)
    console.log(`Configurable parents: ${configurableCount}`)
    console.log(`S3 segments prefix  : s3://${S3_BUCKET}/${S3_PARENTS_PREFIX}/`)
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
