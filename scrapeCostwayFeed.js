import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fs from 'fs'
import { createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import fetch from 'node-fetch'
import { S3 as AWSS3, PutObjectCommand } from '@aws-sdk/client-s3'

// ── Config ──────────────────────────────────────────────────────────────────
const OUTPUT_DIR = './costway_data'
const MAP_DIR = `${OUTPUT_DIR}/map`
const FEED_CACHE_FILE = `${OUTPUT_DIR}/feed_cache.csv`
const FEED_URL = 'https://www.costway.com/media/feed/US-Dropship-Shopify.csv'
const MIN_FEED_BYTES = 50 * 1024 * 1024
const DELAY_MS = parseInt(process.argv[2]) || 250
const MAX_RETRIES = 5
const SAVE_EVERY = 200
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
    } catch {
        return fallback
    }
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

async function getRemoteFeedSize() {
    try {
        const res = await fetch(FEED_URL, {
            method: 'HEAD',
            headers: { 'User-Agent': 'Mozilla/5.0' },
        })
        if (!res.ok) return null
        const len = parseInt(res.headers.get('content-length'))
        return Number.isFinite(len) ? len : null
    } catch {
        return null
    }
}

async function downloadFeedToCache() {
    console.log(`Downloading feed from ${FEED_URL} ...`)
    const feedRes = await fetch(FEED_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!feedRes.ok) throw new Error(`Feed download failed: ${feedRes.status}`)

    const tempFile = `${FEED_CACHE_FILE}.tmp`
    await pipeline(feedRes.body, createWriteStream(tempFile))

    const bytes = fs.statSync(tempFile).size
    if (bytes < MIN_FEED_BYTES) {
        fs.unlinkSync(tempFile)
        throw new Error(`Downloaded feed too small (${bytes} bytes), refusing to cache partial file`)
    }

    fs.renameSync(tempFile, FEED_CACHE_FILE)
    console.log(`Feed cached to ${FEED_CACHE_FILE} (${Math.round(bytes / 1024 / 1024)} MB)`)
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

// Extract the fep query param from an Item Link URL
function extractFep(itemLink) {
    if (!itemLink) return null
    try {
        const url = new URL(itemLink)
        const fep = url.searchParams.get('fep')
        return fep ? fep.trim() : null
    } catch {
        return null
    }
}

async function fetchResult(id, retries = MAX_RETRIES) {
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
                console.error(`  ⏳ ${id}: 429, waiting ${waitMs / 1000}s (attempt ${attempt}/${retries})`)
                await sleep(waitMs)
                continue
            }
            if (!res.ok) return { ok: false, status: res.status, result: null }
            const payload = await res.json()
            const result = payload?.result ?? null
            if (!result) return { ok: false, status: 204, result: null }
            return { ok: true, status: 200, result }
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

// Build parent-children and children-parent maps from pdp_associated_products.
// Treats the fetched product as the parent and its associated products as children.
function updateMappings(id, result, parentChildren, childParent) {
    if (!result) return 0
    const associated = Array.isArray(result.pdp_associated_products) ? result.pdp_associated_products : []
    if (!associated.length) return 0

    const parentId = String(id)
    const childrenSet = new Set(parentChildren[parentId] || [])
    let newLinks = 0

    for (const item of associated) {
        const childId = item?.product_id != null ? String(item.product_id) : null
        if (!childId) continue
        if (!childrenSet.has(childId)) {
            childrenSet.add(childId)
            newLinks++
        }
        childParent[childId] = parentId
    }

    parentChildren[parentId] = Array.from(childrenSet)
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

    // Use cache only if it looks complete; otherwise force a fresh download.
    const remoteBytes = await getRemoteFeedSize()
    if (fs.existsSync(FEED_CACHE_FILE)) {
        const localBytes = fs.statSync(FEED_CACHE_FILE).size
        if (remoteBytes && localBytes !== remoteBytes) {
            console.log(`Feed cache size mismatch (${localBytes} local vs ${remoteBytes} remote), refreshing cache`)
            await downloadFeedToCache()
        } else if (localBytes < MIN_FEED_BYTES) {
            console.log(`Feed cache is too small (${localBytes} bytes), refreshing cache`)
            await downloadFeedToCache()
        } else {
            console.log(`Using cached feed at ${FEED_CACHE_FILE} (${Math.round(localBytes / 1024 / 1024)} MB)`)
        }
    } else {
        await downloadFeedToCache()
    }

    const feedCsv = fs.readFileSync(FEED_CACHE_FILE, 'utf8')

    // Parse the feed: it's unquoted comma-delimited with raw HTML in body fields.
    // We only need the "Item Link" column (index 3), which is a plain URL with no commas.
    const lines = feedCsv.split('\n')
    const header = lines[0].split(',')
    const itemLinkIndex = header.indexOf('Item Link')
    if (itemLinkIndex === -1) throw new Error('Could not find "Item Link" column in feed header')

    const idSet = new Set()
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line) continue
        const fields = line.split(',')
        const fep = extractFep(fields[itemLinkIndex])
        if (fep) idSet.add(fep)
    }
    const ids = Array.from(idSet)
    console.log(`${lines.length - 1} feed rows → ${ids.length} unique product IDs`)

    // Load existing state for resume
    const parentChildren = readJson(PARENT_CHILDREN_FILE, {})
    const childParent = readJson(CHILD_PARENT_FILE, {})
    const progress = readJson(PROGRESS_FILE, { processedIds: [], uploadedCount: 0, foundCount: 0, linkCount: 0 })
    const done = new Set(progress.processedIds || [])

    let uploadedCount = progress.uploadedCount || 0
    let foundCount = progress.foundCount || 0
    let linkCount = progress.linkCount || 0

    const remaining = ids.filter((id) => !done.has(id))
    console.log(`${done.size} already processed, ${remaining.length} remaining`)
    console.log(`S3 product path: s3://${S3_BUCKET}/${S3_PRODUCT_PREFIX}/{id}\n`)

    for (let i = 0; i < remaining.length; i++) {
        const id = remaining[i]
        const res = await fetchResult(id)

        if (res.ok && res.result) {
            foundCount++
            await uploadJsonToS3(`${S3_PRODUCT_PREFIX}/${id}`, res.result)
            uploadedCount++
            linkCount += updateMappings(id, res.result, parentChildren, childParent)

            if (uploadedCount % 50 === 0) {
                console.log(`  ✓ ${id} (${uploadedCount} uploaded, ${foundCount} found, ${linkCount} links)`)
            }
        } else if (res.status !== 204) {
            console.error(`  ✗ ${id}: ${res.status}${res.error ? ` — ${res.error}` : ''}`)
        }

        done.add(id)
        progress.processedIds = Array.from(done)
        progress.uploadedCount = uploadedCount
        progress.foundCount = foundCount
        progress.linkCount = linkCount

        if ((i + 1) % SAVE_EVERY === 0) {
            await saveState(parentChildren, childParent, progress)
            console.log(`  💾 checkpoint @ ${i + 1}/${remaining.length}`)
        }

        await sleep(DELAY_MS)
    }

    await saveState(parentChildren, childParent, progress)

    console.log('\nUploading maps to S3...')
    await uploadJsonToS3(S3_MAP_PARENT_CHILDREN_KEY, parentChildren)
    await uploadJsonToS3(S3_MAP_CHILD_PARENT_KEY, childParent)

    console.log('\nDone.')
    console.log(`Feed rows: ${lines.length - 1}`)
    console.log(`Unique IDs: ${ids.length}`)
    console.log(`Found + uploaded: ${uploadedCount}`)
    console.log(`Mapping links: ${linkCount}`)
    console.log(`Local maps: ${PARENT_CHILDREN_FILE}, ${CHILD_PARENT_FILE}`)
    console.log(
        `S3 maps: s3://${S3_BUCKET}/${S3_MAP_PARENT_CHILDREN_KEY}, s3://${S3_BUCKET}/${S3_MAP_CHILD_PARENT_KEY}`
    )
}

main().catch((err) => {
    console.error('Fatal:', err)
    process.exit(1)
})
