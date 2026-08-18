import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fs from 'fs'
import fetch from 'node-fetch'
import { S3 as AWSS3, PutObjectCommand } from '@aws-sdk/client-s3'

// ── Config ──────────────────────────────────────────────────────────────────
const START_ID = parseInt(process.argv[2]) || 1
const END_ID = parseInt(process.argv[3]) || 100000
const DELAY_MS = parseInt(process.argv[4]) || 250
const MAX_RETRIES = 5
const SAVE_EVERY = 200
const OUTPUT_DIR = './costway_data'
const MAP_DIR = `${OUTPUT_DIR}/map`
const PARENT_CHILDREN_FILE = `${MAP_DIR}/parent-children.json`
const CHILD_PARENT_FILE = `${MAP_DIR}/children-parent.json`
const PROGRESS_FILE = `${OUTPUT_DIR}/scrape_progress.json`

const S3_BUCKET = 'fpdash-bucket'
const S3_PRODUCT_PREFIX = 'costwaydata'
const S3_MAP_PARENT_CHILDREN_KEY = 'costwaydata/map/parent-children'
const S3_MAP_CHILD_PARENT_KEY = 'costwaydata/map/children-parent'

const S3 = new AWSS3({ region: process.env.AWS_REGION || 'us-east-1' })

// ── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ensureDirs() {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
    if (!fs.existsSync(MAP_DIR)) fs.mkdirSync(MAP_DIR, { recursive: true })
}

function readJson(filePath, fallback = {}) {
    if (!fs.existsSync(filePath)) return fallback
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (err) {
        console.error(`Failed to read ${filePath}: ${err.message}`)
        return fallback
    }
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

async function uploadJsonToS3(key, value) {
    await S3.send(
        new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: key,
            Body: JSON.stringify(value),
            ContentType: 'application/json',
        })
    )
}

async function fetchResult(id, retries = MAX_RETRIES) {
    const url = `https://www.costway.com/api/product/${id}`

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
                    'Accept': 'application/json',
                },
            })

            if (res.status === 429) {
                const waitMs = Math.min(60000, Math.pow(2, attempt) * 1000)
                console.error(`  ⏳ ${id}: 429, waiting ${waitMs}ms (attempt ${attempt}/${retries})`)
                await sleep(waitMs)
                continue
            }

            if (!res.ok) {
                return { ok: false, status: res.status, result: null }
            }

            const payload = await res.json()
            const result = payload?.result ?? null
            if (!result) return { ok: false, status: 204, result: null }
            return { ok: true, status: 200, result }
        } catch (err) {
            if (attempt < retries) {
                const waitMs = attempt * 1000
                console.error(`  ⏳ ${id}: network error (${err.message}), retrying in ${waitMs}ms`)
                await sleep(waitMs)
                continue
            }
            return { ok: false, status: 0, result: null, error: err.message }
        }
    }

    return { ok: false, status: 429, result: null }
}

function updateMappingsFromResult(result, parentChildren, childParent) {
    if (!result || result.type_id !== 'configurable') return 0

    const relation = Array.isArray(result.relation) ? result.relation : []
    if (!relation.length) return 0

    let newLinks = 0

    for (const rel of relation) {
        const parentId = rel?.parent_id != null ? String(rel.parent_id) : null
        const childId = rel?.product_id != null ? String(rel.product_id) : null
        if (!parentId || !childId) continue

        const childrenSet = new Set(parentChildren[parentId] || [])

        if (!childrenSet.has(childId)) {
            childrenSet.add(childId)
            newLinks++
        }

        parentChildren[parentId] = Array.from(childrenSet)
        childParent[childId] = parentId
    }

    return newLinks
}

async function saveState(parentChildren, childParent, progress) {
    writeJson(PARENT_CHILDREN_FILE, parentChildren)
    writeJson(CHILD_PARENT_FILE, childParent)
    writeJson(PROGRESS_FILE, progress)
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    ensureDirs()

    const parentChildren = readJson(PARENT_CHILDREN_FILE, {})
    const childParent = readJson(CHILD_PARENT_FILE, {})
    const progress = readJson(PROGRESS_FILE, { lastProcessedId: START_ID - 1, uploadedCount: 0, foundCount: 0, linkCount: 0 })

    const resumeFrom = Math.max(START_ID, (progress.lastProcessedId || START_ID - 1) + 1)
    let uploadedCount = progress.uploadedCount || 0
    let foundCount = progress.foundCount || 0
    let linkCount = progress.linkCount || 0

    console.log(`Scraping Costway IDs ${resumeFrom}..${END_ID}`)
    console.log(`S3 product path: s3://${S3_BUCKET}/${S3_PRODUCT_PREFIX}/{id}`)

    for (let id = resumeFrom; id <= END_ID; id++) {
        const res = await fetchResult(id)

        if (res.ok && res.result) {
            foundCount++

            const s3Key = `${S3_PRODUCT_PREFIX}/${id}`
            await uploadJsonToS3(s3Key, res.result)
            uploadedCount++

            linkCount += updateMappingsFromResult(res.result, parentChildren, childParent)

            if (uploadedCount % 50 === 0) {
                console.log(`  ✓ ${id} uploaded (${uploadedCount} uploaded, ${foundCount} found, ${linkCount} links)`)
            }
        } else if (res.status === 429) {
            console.error(`  ✗ ${id}: failed after retries (429)`)
        } else if (res.status !== 404 && res.status !== 204) {
            console.error(`  ✗ ${id}: status ${res.status}${res.error ? ` (${res.error})` : ''}`)
        }

        progress.lastProcessedId = id
        progress.uploadedCount = uploadedCount
        progress.foundCount = foundCount
        progress.linkCount = linkCount

        if ((id - resumeFrom + 1) % SAVE_EVERY === 0) {
            await saveState(parentChildren, childParent, progress)
            console.log(`  💾 checkpoint @ ${id}`)
        }

        await sleep(DELAY_MS)
    }

    await saveState(parentChildren, childParent, progress)

    await uploadJsonToS3(S3_MAP_PARENT_CHILDREN_KEY, parentChildren)
    await uploadJsonToS3(S3_MAP_CHILD_PARENT_KEY, childParent)

    console.log('\nDone.')
    console.log(`Found: ${foundCount}`)
    console.log(`Uploaded: ${uploadedCount}`)
    console.log(`Parent->Child links: ${linkCount}`)
    console.log(`Local maps: ${PARENT_CHILDREN_FILE}, ${CHILD_PARENT_FILE}`)
    console.log(`S3 maps: s3://${S3_BUCKET}/${S3_MAP_PARENT_CHILDREN_KEY}, s3://${S3_BUCKET}/${S3_MAP_CHILD_PARENT_KEY}`)
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
