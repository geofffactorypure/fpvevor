import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fs from 'fs'
import fetch from 'node-fetch'
import { parse } from 'csv-parse/sync'
import { URL } from 'url'
import { S3 as AWSS3, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'

// ── Config ──────────────────────────────────────────────────────────────────
const DELAY_MS = parseInt(process.argv[2]) || 400
const MAX_RETRIES = 5
const FEED_CACHE_PATH = './costway_data/new_costway_feed_skus.csv'

const S3_BUCKET = 'fpdash-bucket'
const S3_PRODUCT_PREFIX = 'costwaydata'
const S3_PROGRESS_KEY = 'costwaydata/feedProductsProgress'

const S3 = new AWSS3({ region: process.env.AWS_REGION || 'us-east-1' })

// ── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getS3Json(key) {
    try {
        const res = await S3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }))
        return JSON.parse(await res.Body.transformToString())
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

async function fetchProduct(id, retries = MAX_RETRIES) {
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
            if (!res.ok) return null
            const payload = await res.json()
            return payload?.result ?? null
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

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
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
        const rawLink = row['Item Link']
        if (!rawLink) continue

        try {
            const link = String(rawLink)
                .trim()
                .replace(/^["']|["']$/g, '') // strip surrounding quotes
                .replace(/[\u200B-\u200D\uFEFF]/g, '') // remove zero-width chars/BOM

            const url = new URL(link.startsWith('http') ? link : `https://${link}`)

            const fep = parseInt(url.searchParams.get('fep'), 10)
            if (!Number.isNaN(fep)) {
                fepSet.add(fep)
            }
        } catch (err) {
            console.warn(`Invalid URL in feed: ${JSON.stringify(rawLink)} (${err.message})`)
        }
    }
    const fepIds = [...fepSet].sort((a, b) => a - b)
    console.log(`Feed rows: ${rows.length} → unique FEP IDs: ${fepIds.length}`)

    let progress = { lastProcessedIndex: -1, cached: 0, fetched: 0 }
    const resumeFrom = (progress.lastProcessedIndex ?? -1) + 1
    let cached = progress.cached || 0
    let fetched = progress.fetched || 0

    console.log(`Resuming from index ${resumeFrom} / ${fepIds.length}`)
    console.log(`Already cached: ${cached}, fetched: ${fetched}`)

    for (let i = resumeFrom; i < fepIds.length; i++) {
        const id = fepIds[i]

        if (i > 0 && i % 500 === 0) {
            console.log(`  … index ${i}/${fepIds.length} (cached=${cached} fetched=${fetched})`)
        }

        const existing = await getS3Json(`${S3_PRODUCT_PREFIX}/${id}`)
        if (existing) {
            cached++
        } else {
            const product = await fetchProduct(id)
            await sleep(DELAY_MS)
            if (product) {
                await putS3Json(`${S3_PRODUCT_PREFIX}/${id}`, product)
                fetched++
                console.log(`  ✓ ${id} fetched & stored (${product.type_id}, sku=${product.sku})`)
            } else {
                console.warn(`  ✗ ${id}: no result from API`)
            }
        }

        progress.lastProcessedIndex = i
        progress.cached = cached
        progress.fetched = fetched
        if (i % 100 === 0) await putS3Json(S3_PROGRESS_KEY, progress)
    }

    await putS3Json(S3_PROGRESS_KEY, progress)

    console.log('\nDone.')
    console.log(`Already in S3 : ${cached}`)
    console.log(`Newly fetched  : ${fetched}`)
    console.log(`Total          : ${cached + fetched} / ${fepIds.length}`)
}

main().catch((err) => {
    console.error('Fatal:', err)
    process.exit(1)
})
