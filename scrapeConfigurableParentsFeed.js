import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fs from 'fs'
import fetch from 'node-fetch'
import { parse } from 'csv-parse/sync'
import { URL } from 'url'
import { S3 as AWSS3, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'

// ── Config ──────────────────────────────────────────────────────────────────
const DELAY_MS = parseInt(process.argv[2]) || 400 // only applied to live API calls
const MAX_RETRIES = 5
const FEED_CACHE_PATH = './costway_data/feed_cache.csv'

const S3_BUCKET = 'fpdash-bucket'
const S3_PRODUCT_PREFIX = 'costwaydata'
const S3_CAT_PREFIX = 'costwaydata/categoryProducts'
const S3_PARENTS_PREFIX = 'costwaydata/configurableParents'
const S3_PROGRESS_KEY = 'costwaydata/configurableParentsFeedProgress'

const S3 = new AWSS3({ region: process.env.AWS_REGION || 'us-east-1' })

// ── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    const cacheKey = `${S3_CAT_PREFIX}/${categoryId}`
    const cached = await getS3Json(cacheKey)
    if (cached !== null) return cached

    const url = `https://www.costway.com/api/products?sku=${encodeURIComponent(sku)}&category_id=${categoryId}&pagesize=10000`
    const payload = await fetchJson(url)
    await sleep(DELAY_MS)

    if (!payload?.result) return null
    await putS3Json(cacheKey, payload.result)
    return payload.result
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    // ── Load feed ────────────────────────────────────────────────────────────
    if (!fs.existsSync(FEED_CACHE_PATH)) {
        console.error('Feed cache not found at', FEED_CACHE_PATH)
        process.exit(1)
    }
    const feedCsv = fs.readFileSync(FEED_CACHE_PATH, 'utf8')
    const rows = parse(feedCsv, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        quote: false,
    })

    const fepSet = new Set()
    for (const row of rows) {
        const link = row['Item Link']
        if (!link) continue
        try {
            const fep = new URL(link).searchParams.get('fep')
            if (fep && !isNaN(parseInt(fep))) fepSet.add(parseInt(fep))
        } catch {}
    }
    const fepIds = [...fepSet].sort((a, b) => a - b)
    console.log(`Feed rows: ${rows.length} → unique FEP IDs: ${fepIds.length}`)

    // ── Load progress ────────────────────────────────────────────────────────
    let progress = (await getS3Json(S3_PROGRESS_KEY)) ?? { lastProcessedIndex: -1, configurableCount: 0, batchIndex: 0 }
    let configurableCount = progress.configurableCount || 0
    let batchIndex = progress.batchIndex || 0
    const resumeFrom = (progress.lastProcessedIndex ?? -1) + 1

    const seenParents = new Set()
    let currentBatch = {}
    let batchCount = 0

    console.log(`Resuming from index ${resumeFrom} / ${fepIds.length}`)
    console.log(`Configurable parents so far: ${configurableCount}, batch index: ${batchIndex}`)

    for (let i = resumeFrom; i < fepIds.length; i++) {
        const fepId = fepIds[i]

        if (i > 0 && i % 500 === 0) {
            console.log(`  … index ${i}/${fepIds.length} (${configurableCount} parents found so far)`)
        }

        // ── Step 1: get product data (with API fallback) ─────────────────
        let product = await getS3Json(`${S3_PRODUCT_PREFIX}/${fepId}`)
        if (!product) {
            const payload = await fetchJson(`https://www.costway.com/api/product/${fepId}`)
            await sleep(DELAY_MS)
            if (!payload?.result) continue
            product = payload.result
            await putS3Json(`${S3_PRODUCT_PREFIX}/${fepId}`, product)
        }

        const sku = product.sku
        const position = Array.isArray(product.position) ? product.position : []
        if (!sku || !position.length) continue

        const leafCategoryId = position[position.length - 1]?.entity_id
        if (!leafCategoryId) continue

        // ── Step 2: get category product listing (cached) ─────────────────
        const listing = await getCategoryListing(leafCategoryId, sku)
        if (!listing) continue

        const listingItems = listing.data ?? listing.items ?? []
        if (!Array.isArray(listingItems)) continue

        // ── Step 3: find current product in listing → get parent_id ───────
        const self = listingItems.find((x) => x.entity_id === fepId || x.product_id === fepId)
        if (!self) continue

        const rawParentId = self.parent_id
        // If parent_id is 0 or missing, the product has no configurable parent — treat it as its own parent
        const parentId = rawParentId && rawParentId !== 0 ? rawParentId : fepId

        // ── Step 4: get parent product data ───────────────────────────────
        let parentProduct
        if (parentId === fepId) {
            // No configurable parent — product is its own parent, use it directly
            parentProduct = product
        } else {
            parentProduct = await getS3Json(`${S3_PRODUCT_PREFIX}/${parentId}`)
            if (!parentProduct) {
                const payload = await fetchJson(`https://www.costway.com/api/product/${parentId}`)
                await sleep(DELAY_MS)
                if (!payload?.result) continue
                parentProduct = payload.result
                await putS3Json(`${S3_PRODUCT_PREFIX}/${parentId}`, parentProduct)
            }
            if (parentProduct.type_id !== 'configurable') continue
        }

        // ── Step 5: accumulate parent in batch ────────────────────────────
        if (!seenParents.has(parentId)) {
            seenParents.add(parentId)
            const entry = buildParentEntry(parentProduct)
            currentBatch[parentId] = entry
            batchCount++
            configurableCount++

            console.log(
                `  ✓ fep=${fepId} → parent=${parentId} (${entry.associatedProducts.length} assoc, ${(entry.options || []).length} opts)`
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

    progress.lastProcessedIndex = fepIds.length - 1
    progress.configurableCount = configurableCount
    progress.batchIndex = batchIndex
    await putS3Json(S3_PROGRESS_KEY, progress)

    console.log('\nDone.')
    console.log(`FEP IDs processed : ${fepIds.length - resumeFrom}`)
    console.log(`Configurable parents found : ${configurableCount}`)
}

main().catch((err) => {
    console.error('Fatal:', err)
    process.exit(1)
})
