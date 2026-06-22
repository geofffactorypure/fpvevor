import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })
import mysql from 'mysql'
import fs, { createWriteStream } from 'fs'
import fetch from 'node-fetch'
import { parse } from 'csv-parse/sync'
import { URL } from 'url'
import { S3 as AWSS3, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { pipeline } from 'stream/promises'

// ── Config ──────────────────────────────────────────────────────────────────
const DELAY_MS = parseInt(process.argv[2]) || 400 // only applied to live API calls
const MAX_RETRIES = 5
const FEED_CACHE_PATH = './costway_data/feed_cache.csv'
const OUTPUT_DIR = './costway_data'
const S3_BUCKET = 'fpdash-bucket'
const S3_PRODUCT_PREFIX = 'costwaydata'
const S3_CAT_PREFIX = 'costwaydata/categoryProducts'
const S3_PARENTS_PREFIX = 'costwaydata/configurableParents'
const S3_PROGRESS_KEY = 'costwaydata/configurableParentsFeedProgress'
const FEED_CACHE_FILE = `${OUTPUT_DIR}/feed_cache.csv`
const FEED_URL = 'https://www.costway.com/media/feed/US-Dropship-Shopify.csv'
const MIN_FEED_BYTES = 50 * 1024 * 1024

const S3 = new AWSS3({ region: process.env.AWS_REGION || 'us-east-1' })
const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

function createPool() {
    return mysql.createPool({
        connectionLimit: 5,
        host: DB_WRITE_HOST,
        user: DB_USER,
        password: DB_PASSWORD,
        port: 3306,
        database: 'main',
        timezone: '+00:00',
    })
}

function query(pool, sql, args = []) {
    return new Promise((resolve, reject) => {
        pool.query(sql, args, (err, results) => {
            if (err) return reject(err)
            resolve(results)
        })
    })
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

async function fetchJson(url, retries = MAX_RETRIES) {
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
                console.error(`  ⏳ 429 on ${url}, waiting ${waitMs}ms (attempt ${attempt}/${retries})`)
                await sleep(waitMs)
                continue
            }
            if (!res.ok) return null
            return await res.json()
        } catch (err) {
            if (attempt < retries) {
                await sleep(attempt * 1000)
                continue
            }
            return null
        }
    }
    return null
}

async function postJson(url, body, retries = MAX_RETRIES) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                body: JSON.stringify(body),
            })
            if (res.status === 429) {
                const waitMs = Math.min(60000, Math.pow(2, attempt) * 1000)
                console.error(`  ⏳ 429 on POST ${url}, waiting ${waitMs}ms (attempt ${attempt}/${retries})`)
                await sleep(waitMs)
                continue
            }
            if (!res.ok) {
                const waitMs = Math.min(60000, Math.pow(2, attempt) * 1000)
                console.error(
                    `  ⏳ HTTP ${res.status} on POST ${url}, waiting ${waitMs}ms (attempt ${attempt}/${retries})`
                )
                await sleep(waitMs)
                continue
            }
            const result = await res.json()
            if (!result?.data?.datalist[0]) {
                const waitMs = Math.min(60000, Math.pow(2, attempt) * 1000)
                console.error(
                    `  ⏳ Invalid response format from POST ${url}, waiting ${waitMs}ms (attempt ${attempt}/${retries})`
                )
                await sleep(waitMs)
                continue
            }
            return result
        } catch (err) {
            if (attempt < retries) {
                await sleep(attempt * 1000)
                continue
            }
            return null
        }
    }
    return null
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
                instructions_pdf: p.instructions_pdf,
                price: p.price,
                images: p.images,
            })) ?? null,
    }
}

// ── Category product listing (S3-cached) ────────────────────────────────────
async function getCategoryListing(categoryId, sku) {
    console.log(`  Fetching category listing for category_id=${categoryId} (looking for SKU=${sku})`)
    const cacheKey = `${S3_CAT_PREFIX}/${categoryId}`
    const cached = await getS3Json(cacheKey)
    if (cached !== null) return cached

    const url = `https://www.costway.com/api/products?category_id=${categoryId}&pagesize=10000`
    const payload = await fetchJson(url)
    await sleep(DELAY_MS)

    if (!payload?.result) return null
    await putS3Json(cacheKey, payload.result)
    return payload.result
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    // await downloadFeedToCache()
    const pool = createPool()
    // ── Load feed ────────────────────────────────────────────────────────────
    if (!fs.existsSync(FEED_CACHE_PATH)) {
        console.error('Feed cache not found at', FEED_CACHE_PATH)
        process.exit(1)
    }
    const listedSkuRows = await query(
        pool,
        `SELECT vn.sku FROM variants_new vn JOIN products p ON p.id = vn.product_id WHERE p.vendor = 'Costway' AND vn.sku IS NOT NULL`
    )
    const listedSkuSet = new Set(listedSkuRows.map((r) => r.sku))
    const feedCsv = fs.readFileSync(FEED_CACHE_PATH, 'utf8')
    const rows = parse(feedCsv, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        quote: false,
    })

    // const fepSet = new Set()
    const itemNoSet = new Set()
    // for (const row of rows) {
    //     const rawLink = row['Item Link']
    //     if (!rawLink) continue

    //     try {
    //         const link = String(rawLink)
    //             .trim()
    //             .replace(/^["']|["']$/g, '') // strip surrounding quotes
    //             .replace(/[\u200B-\u200D\uFEFF]/g, '') // remove zero-width chars/BOM

    //         const url = new URL(link.startsWith('http') ? link : `https://${link}`)

    //         const fep = parseInt(url.searchParams.get('fep'), 10)
    //         if (!Number.isNaN(fep)) {
    //             fepSet.add(fep)
    //         }
    //     } catch (err) {
    //         console.warn(`Invalid URL in feed: ${JSON.stringify(rawLink)} (${err.message})`)
    //     }
    // }
    for (const row of rows) {
        const itemNo = (row['Item No'] || '').trim()
        const sku = (row['Variant SKU'] || '').trim()
        if (itemNo && !listedSkuSet.has(sku)) {
            itemNoSet.add(itemNo)
        }
    }
    // const fepIds = [...fepSet].sort((a, b) => a - b)
    console.log(`Feed rows: ${rows.length} → unique Item Nos: ${itemNoSet.size}`)

    // ── Load progress ────────────────────────────────────────────────────────
    let progress = { lastProcessedIndex: 2299, configurableCount: 0, batchIndex: 0 }
    let configurableCount = progress.configurableCount || 0
    let batchIndex = progress.batchIndex || 0
    const resumeFrom = (progress.lastProcessedIndex ?? -1) + 1

    const seenParents = new Set()
    let currentBatch = {}
    let batchCount = 0

    console.log(`Resuming from index ${resumeFrom} / ${itemNoSet.size}`)
    console.log(`Configurable parents so far: ${configurableCount}, batch index: ${batchIndex}`)

    for (let i = resumeFrom; i < itemNoSet.size; i++) {
        const itemNo = [...itemNoSet][i]

        if (i > 0 && i % 500 === 0) {
            console.log(`  … index ${i}/${itemNoSet.size} (${configurableCount} parents found so far)`)
        }

        // ── Step 1: get product data (with API fallback) ─────────────────
        const product = await searchApiForProduct(itemNo)
        await sleep(DELAY_MS)
        if (!product) {
            console.log(`  ✗ itemNo=${itemNo}: no product data from API, skipping`)
            continue
        }

        const sku = product.sku

        const parentProductPayload = await fetchJson(
            `https://www.costway.com/api/product/${product.parentId || product.productId}`
        )
        const parentProduct = parentProductPayload?.result

        // ── Step 5: accumulate parent in batch ────────────────────────────
        const parentId = product?.parent_id || product?.productId
        if (!seenParents.has(parentId)) {
            seenParents.add(parentId)
            const entry = buildParentEntry(parentProduct)
            currentBatch[parentId] = entry
            batchCount++
            configurableCount++

            console.log(
                `  ✓ itemNo=${itemNo} → parent=${parentId} (${entry.associatedProducts.length} assoc, ${(entry.options || []).length} opts)`
            )

            if (batchCount >= 100) {
                await putS3Json(`${S3_PARENTS_PREFIX}/${batchIndex * 100}`, currentBatch)
                batchIndex++
                currentBatch = {}
                batchCount = 0
                progress.lastProcessedIndex = i
                progress.configurableCount = configurableCount
                progress.batchIndex = batchIndex
                await putS3Json(S3_PROGRESS_KEY, progress)
                console.log(`  💾 batch flushed → key ${S3_PARENTS_PREFIX}/${(batchIndex - 1) * 100} @ index ${i}`)
            }
        }
    }

    // Flush any remaining partial batch
    if (batchCount > 0) {
        await putS3Json(`${S3_PARENTS_PREFIX}/${batchIndex * 100}`, currentBatch)
        batchIndex++
        console.log(`  💾 final batch flushed → key ${S3_PARENTS_PREFIX}/${(batchIndex - 1) * 100}`)
    }

    progress.lastProcessedIndex = itemNoSet.size - 1
    progress.configurableCount = configurableCount
    progress.batchIndex = batchIndex
    await putS3Json(S3_PROGRESS_KEY, progress)

    console.log('\nDone.')
    console.log(`Item Nos processed : ${itemNoSet.size - resumeFrom}`)
    console.log(`Configurable parents found : ${configurableCount}`)
}

main().catch((err) => {
    console.error('Fatal:', err)
    process.exit(1)
})

function findProductInListing(listingItems, fepId) {
    const fepNum = Number(fepId)

    for (const item of listingItems) {
        if (Number(item.entity_id) === fepNum || Number(item.product_id) === fepNum) {
            return item
        }

        if (Array.isArray(item.relation)) {
            const relationMatch = item.relation.find(
                (r) => Number(r.product_id) === fepNum || Number(r.entity_id) === fepNum
            )

            if (relationMatch) {
                return {
                    ...relationMatch,
                    parent_id: relationMatch.parent_id ?? item.parent_id,
                    product_id: relationMatch.product_id ?? fepNum,
                    entity_id: relationMatch.entity_id ?? relationMatch.product_id ?? fepNum,
                }
            }
        }
    }

    return null
}

async function searchApiForProduct(itemNo) {
    const url = 'https://www.costway.com/searchApi/mobile/search'
    const body = {
        keyword: itemNo,
        page: 1,
        pageSize: 48,
        userId: 0,
        isLogin: false,
    }
    const result = await postJson(url, body)
    return result?.data?.datalist?.[0]
}
