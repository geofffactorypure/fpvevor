import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import sharp from 'sharp'
import mysql from 'mysql'
import fs from 'fs'

// ── Config ──────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2026-01'
const CONCURRENCY = 30
const PAGE_SIZE = 50

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

// ── DB ──────────────────────────────────────────────────────────────────────
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

async function getStoreInfo(pool) {
    const rows = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
    if (!rows.length) throw new Error(`Store ${STORE_ID} not found`)
    return rows[0]
}

// ── Shopify GraphQL ─────────────────────────────────────────────────────────
async function shopifyGraphQL(storeInfo, queryStr, variables, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(
                `https://${storeInfo.shopify_name}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Shopify-Access-Token': storeInfo.access_token,
                    },
                    body: JSON.stringify({ query: queryStr, variables }),
                }
            )
            if (res.status === 429 || res.status >= 500) {
                throw new Error(`Shopify returned ${res.status}`)
            }
            return res.json()
        } catch (err) {
            if (attempt === retries) throw err
            const delay = 2000 * attempt
            await new Promise((resolve) => setTimeout(resolve, delay))
        }
    }
}

// ── Image Quality Scoring ───────────────────────────────────────────────────
async function scoreImageBuffer(buffer) {
    // Laplacian variance (sharpness)
    const { data, info } = await sharp(buffer).grayscale().raw().toBuffer({ resolveWithObject: true })

    const { width, height } = info

    let lapSum = 0
    let lapSumSq = 0
    let lapCount = 0

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const center = data[y * width + x]
            const top = data[(y - 1) * width + x]
            const bottom = data[(y + 1) * width + x]
            const left = data[y * width + (x - 1)]
            const right = data[y * width + (x + 1)]
            const laplacian = top + bottom + left + right - 4 * center
            lapSum += laplacian
            lapSumSq += laplacian * laplacian
            lapCount++
        }
    }

    const lapMean = lapSum / lapCount
    const lapVariance = lapSumSq / lapCount - lapMean * lapMean

    // Gradient energy
    let gradSum = 0
    let gradCount = 0
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const gx = data[y * width + (x + 1)] - data[y * width + (x - 1)]
            const gy = data[(y + 1) * width + x] - data[(y - 1) * width + x]
            gradSum += gx * gx + gy * gy
            gradCount++
        }
    }
    const gradEnergy = gradSum / gradCount

    // Whitespace detection
    const { data: rgbaData, info: rgbaInfo } = await sharp(buffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })

    const w = rgbaInfo.width
    const h = rgbaInfo.height
    const ch = 4

    const metadata = await sharp(buffer).metadata()
    const hasAlpha = metadata.channels === 4

    function isEmpty(x, y) {
        const offset = (y * w + x) * ch
        const r = rgbaData[offset]
        const g = rgbaData[offset + 1]
        const b = rgbaData[offset + 2]
        const a = rgbaData[offset + 3]
        if (hasAlpha) return a < 10
        return r >= 250 && g >= 250 && b >= 250
    }

    let topDist = 0
    topSearch: for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!isEmpty(x, y)) break topSearch
        }
        topDist++
    }

    let bottomDist = 0
    bottomSearch: for (let y = h - 1; y >= 0; y--) {
        for (let x = 0; x < w; x++) {
            if (!isEmpty(x, y)) break bottomSearch
        }
        bottomDist++
    }

    let leftDist = 0
    leftSearch: for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
            if (!isEmpty(x, y)) break leftSearch
        }
        leftDist++
    }

    let rightDist = 0
    rightSearch: for (let x = w - 1; x >= 0; x--) {
        for (let y = 0; y < h; y++) {
            if (!isEmpty(x, y)) break rightSearch
        }
        rightDist++
    }

    const totalWhitespacePct = (((topDist + bottomDist) / h + (leftDist + rightDist) / w) / 2) * 100

    return {
        width: w,
        height: h,
        lapVariance: Math.round(lapVariance * 10) / 10,
        gradEnergy: Math.round(gradEnergy * 10) / 10,
        whitespacePct: Math.round(totalWhitespacePct * 10) / 10,
    }
}

// ── Fetch all products with featured image ──────────────────────────────────
async function fetchAllProducts(storeInfo) {
    const products = []
    let cursor = null
    let hasNext = true

    while (hasNext) {
        const afterClause = cursor ? `, after: "${cursor}"` : ''
        const gqlQuery = `
      {
        products(first: ${PAGE_SIZE}${afterClause}, query: "status:active") {
          pageInfo { hasNextPage }
          edges {
            cursor
            node {
              id
              title
              handle
              onlineStoreUrl
              featuredImage {
                url
                width
                height
              }
            }
          }
        }
      }
    `

        const result = await shopifyGraphQL(storeInfo, gqlQuery)

        if (result.errors) {
            console.error('GraphQL errors:', result.errors)
            break
        }

        const edges = result.data.products.edges
        for (const edge of edges) {
            if (edge.node.onlineStoreUrl) {
                products.push(edge.node)
            }
            cursor = edge.cursor
        }

        hasNext = result.data.products.pageInfo.hasNextPage
        process.stdout.write(`\r  Fetched ${products.length} products...`)
    }

    console.log(`\r  Fetched ${products.length} products total.`)
    return products
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const pool = createPool()

    try {
        const storeInfo = await getStoreInfo(pool)
        console.log('=== Image Quality Audit ===\n')

        // 1. Fetch all products
        console.log('Fetching products from Shopify...')
        const products = await fetchAllProducts(storeInfo)

        const productsWithImages = products.filter((p) => p.featuredImage?.url)
        console.log(`\n${productsWithImages.length} products have featured images.\n`)

        // 2. Score each image, writing CSV incrementally
        const csvPath = 'image_quality_audit.csv'
        const csvHeader = 'id,title,handle,imageUrl,width,height,lapVariance,gradEnergy,whitespacePct,error'
        fs.writeFileSync(csvPath, csvHeader + '\n')

        const results = []
        let processed = 0
        let errors = 0

        for (let i = 0; i < productsWithImages.length; i += CONCURRENCY) {
            const chunk = productsWithImages.slice(i, i + CONCURRENCY)

            const chunkResults = await Promise.all(
                chunk.map(async (product) => {
                    try {
                        const imgUrl = product.featuredImage.url.split('?')[0] + '?width=1500'
                        const imgRes = await fetch(imgUrl)
                        if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`)
                        const buffer = Buffer.from(await imgRes.arrayBuffer())

                        const score = await scoreImageBuffer(buffer)
                        processed++
                        process.stdout.write(`\r  Scored ${processed}/${productsWithImages.length} (${errors} errors)`)

                        return {
                            id: product.id,
                            title: product.title,
                            handle: product.handle,
                            imageUrl: product.featuredImage.url,
                            ...score,
                        }
                    } catch (err) {
                        errors++
                        processed++
                        process.stdout.write(`\r  Scored ${processed}/${productsWithImages.length} (${errors} errors)`)
                        return {
                            id: product.id,
                            title: product.title,
                            handle: product.handle,
                            imageUrl: product.featuredImage?.url || '',
                            width: 0,
                            height: 0,
                            lapVariance: -1,
                            gradEnergy: -1,
                            whitespacePct: -1,
                            error: err.message,
                        }
                    }
                })
            )

            // Write each row immediately
            for (const r of chunkResults) {
                const title = `"${(r.title || '').replace(/"/g, '""')}"`
                const error = r.error ? `"${r.error.replace(/"/g, '""')}"` : ''
                const row = `${r.id},${title},${r.handle},${r.imageUrl},${r.width},${r.height},${r.lapVariance},${r.gradEnergy},${r.whitespacePct},${error}\n`
                fs.appendFileSync(csvPath, row)
            }

            results.push(...chunkResults)
        }

        console.log('\n\n  Done scoring all images.\n')
        console.log(`Results written to ${csvPath}`)

        // 4. Summary stats
        const valid = results.filter((r) => r.lapVariance >= 0)
        const lowQuality = valid.filter((r) => r.lapVariance < 50)
        const highWhitespace = valid.filter((r) => r.whitespacePct > 30)

        console.log(`\n── Summary ──`)
        console.log(`  Total scored:       ${valid.length}`)
        console.log(
            `  Low quality (lap<50): ${lowQuality.length} (${((lowQuality.length / valid.length) * 100).toFixed(1)}%)`
        )
        console.log(
            `  High whitespace (>30%): ${highWhitespace.length} (${((highWhitespace.length / valid.length) * 100).toFixed(1)}%)`
        )
        console.log(`  Errors:             ${errors}`)

        if (lowQuality.length > 0) {
            console.log(`\n── Worst 10 by Laplacian Variance ──`)
            lowQuality.sort((a, b) => a.lapVariance - b.lapVariance)
            for (const r of lowQuality.slice(0, 10)) {
                console.log(`  ${r.lapVariance.toString().padStart(6)} | ${r.whitespacePct}% ws | ${r.handle}`)
            }
        }

        if (highWhitespace.length > 0) {
            console.log(`\n── Worst 10 by Whitespace ──`)
            highWhitespace.sort((a, b) => b.whitespacePct - a.whitespacePct)
            for (const r of highWhitespace.slice(0, 10)) {
                console.log(`  ${r.whitespacePct.toString().padStart(5)}% | lap ${r.lapVariance} | ${r.handle}`)
            }
        }
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
