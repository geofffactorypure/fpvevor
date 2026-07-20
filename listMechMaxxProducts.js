import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import fs from 'fs'
import sharp from 'sharp'
import OpenAI from 'openai'
import mysql from 'mysql'
import { parse } from 'csv-parse/sync'
import { S3 as AWSS3 } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { JSDOM } from 'jsdom'
import jwt from 'jsonwebtoken'

// ── Config ──────────────────────────────────────────────────────────────────
const PHOTOROOM_API_KEY = process.env.PHOTOROOM_API_KEY
const FPHOOKS_ENDPOINT = process.env.MODE === 'production' ? 'https://www.fphooks.com' : 'http://localhost:8081'
const STORE_ID = 1
const PRODUCT_TYPE_FILTER = process.argv[2] || null
const LIMIT = parseInt(process.argv[3]) || 10
const CONCURRENCY = parseInt(process.argv[4]) || 5
const SHOPIFY_API_VERSION = '2026-01'
const VENDOR = 'MechMaxx'

const openai = new OpenAI({ apiKey: process.env.OPENAI_AI_LISTER_API_KEY })
const S3 = new AWSS3({ region: 'us-east-1' })

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

async function getProductManuals(pool, sku) {
    return query(
        pool,
        `SELECT title, manual_url FROM product_manuals WHERE supplier_identifier = ? AND status = 'found' AND manual_url IS NOT NULL`,
        [sku]
    )
}

async function getProductSetupDefaults(pool, vendor) {
    return query(
        pool,
        `SELECT d.id, d.company_id, d.checkmarks, d.warranty, d.manuals
         FROM company_product_setup_defaults d
         JOIN ${STORE_ID}_companies c ON c.id = d.company_id
         WHERE c.shopify_vendor_name = ?`,
        [vendor]
    )
}

// ── Spec / Page Parsing ──────────────────────────────────────────────────────

/**
 * Parse the 4-column spec table from MechMaxx product body_html.
 * Returns string[] in "Key::Value" format, excluding warranty rows.
 */
function parseSpecsFromHtml(bodyHtml) {
    if (!bodyHtml) return []
    const dom = new JSDOM(bodyHtml)
    const rows = Array.from(dom.window.document.querySelectorAll('tr'))
    const specs = []
    const warrantyKeys = new Set(['machine warranty', 'engine warranty', 'warranty'])

    for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'))
        // Rows have 4 cells: key1, val1, key2, val2
        for (let i = 0; i + 1 < cells.length; i += 2) {
            const key = cells[i]?.textContent?.replace(/\s+/g, ' ').trim()
            const val = cells[i + 1]?.textContent?.replace(/\s+/g, ' ').trim()
            if (key && val && !warrantyKeys.has(key.toLowerCase())) {
                specs.push(`${key}::${val}`)
            }
        }
    }
    return specs
}

/**
 * Find warranty text from the spec table HTML.
 * Returns a formatted warranty string or null.
 */
function extractWarrantyFromHtml(bodyHtml) {
    if (!bodyHtml) return null
    const dom = new JSDOM(bodyHtml)
    const rows = Array.from(dom.window.document.querySelectorAll('tr'))

    for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'))
        for (let i = 0; i + 1 < cells.length; i += 2) {
            const key = cells[i]?.textContent?.replace(/\s+/g, ' ').trim().toLowerCase()
            const val = cells[i + 1]?.textContent?.replace(/\s+/g, ' ').trim()
            if ((key === 'machine warranty' || key === 'warranty') && val) {
                // Normalize "2 Years" → "2 year", "12 months" → "1 year", etc.
                const yearMatch = val.match(/(\d+)\s*year/i)
                const monthMatch = val.match(/(\d+)\s*month/i)
                if (yearMatch) {
                    const n = parseInt(yearMatch[1])
                    return `${n} year factory warranty`
                }
                if (monthMatch) {
                    const months = parseInt(monthMatch[1])
                    if (months >= 12) {
                        const years = Math.floor(months / 12)
                        return `${years} year factory warranty`
                    }
                    return `${months} month factory warranty`
                }
                return `${val} factory warranty`
            }
        }
    }
    return null
}

// ── Title Prompt ─────────────────────────────────────────────────────────────
const titlePrompt = `Generate a product title for an authorized dealer listing.

Title Rules:
- Format: [brand] [model] [product type] [product title] New
- The model number MUST appear immediately after the brand name
- The product type (human-readable, e.g. "Wood Chipper" not "Chippers/Shredders") MUST appear right after the model number
- The remaining product title words can be SEO optimized and reordered
- Truncate units: 'inches' to 'in', 'feet' to 'ft', 'pounds' to 'lbs', 'horsepower' to 'HP'
- Respond with ONLY raw JSON, no markdown, no code fences: {"title": "..."}

Product Data:
{PRODUCT_DATA}
`

async function generateTitle({ scrapedTitle, modelNumber, productType }) {
    const productData = JSON.stringify(
        { brand: VENDOR, model: modelNumber, product_type: productType, scraped_title: scrapedTitle },
        null,
        2
    )
    const prompt = titlePrompt.replace('{PRODUCT_DATA}', productData)
    const response = await openai.responses.create({ model: 'gpt-5.4', input: prompt })
    // Strip markdown code fences if present (```json ... ``` or ``` ... ```)
    const raw = response.output_text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim()
    let title
    try {
        const parsed = JSON.parse(raw)
        title = parsed.title || scrapedTitle
    } catch {
        title = raw.replace(/^["']|["']$/g, '') || scrapedTitle
    }
    // Ensure model number is present — insert after "MechMaxx " if missing
    if (modelNumber && !title.includes(modelNumber)) {
        title = title.replace(/^MechMaxx\s*/i, `MechMaxx ${modelNumber} `)
    }
    // Normalize abbreviations
    title = title.replace(/\bE-start\b/gi, 'Electric Start')
    // Normalize units with symbols
    title = title.replace(/(\d+\.?\d*)\s*-?\s*(?:inch(?:es)?|in\.?)\b/gi, '$1"')
    title = title.replace(/(\d+\.?\d*)\s*-?\s*(?:feet|foot|ft\.?)\b/gi, "$1'")
    return title
}

// ── MechMaxx Product Scraper ─────────────────────────────────────────────────

/**
 * Scrape all listing data for a MechMaxx product from their Shopify store.
 * Uses the public /products/{handle}.json API for clean data and
 * patchright for JS-rendered sections (overview, features, manuals).
 */
async function scrapeProductData(productUrl) {
    // Strip query params to get the clean product handle
    const urlObj = new URL(productUrl)
    const pathParts = urlObj.pathname.split('/').filter(Boolean)
    const productsIdx = pathParts.indexOf('products')
    if (productsIdx === -1 || productsIdx + 1 >= pathParts.length) {
        throw new Error(`Could not extract product handle from URL: ${productUrl}`)
    }
    const handle = pathParts[productsIdx + 1]

    // 1. Fetch product JSON for title, images, specs
    const jsonUrl = `https://mechmaxx.com/products/${handle}.json`
    const jsonRes = await fetch(jsonUrl, {
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(15000),
    })
    if (!jsonRes.ok) throw new Error(`Failed to fetch product JSON (${jsonRes.status}): ${jsonUrl}`)
    const { product } = await jsonRes.json()

    const title = product.title?.trim()
    const scrapedBarcode = product.variants?.[0]?.barcode?.trim() || ''
    const specifications = parseSpecsFromHtml(product.body_html || '')
    const warranty = extractWarrantyFromHtml(product.body_html || '')

    // Images from product JSON (full resolution, no _1600x transformations)
    const media = (product.images || []).slice(0, 15).map((img) => ({
        alt: img.alt || title,
        mediaContentType: 'IMAGE',
        originalSource: img.src,
    }))

    // 2. Fetch page HTML and parse with JSDOM for overview, features, manuals
    //    (all sections are server-rendered by Shopify Liquid — no browser needed)
    const pageRes = await fetch(`https://mechmaxx.com/products/${handle}`, {
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(20000),
    })
    if (!pageRes.ok) throw new Error(`Failed to fetch product page (${pageRes.status}): ${handle}`)
    const pageHtml = await pageRes.text()
    const pageDom = new JSDOM(pageHtml)
    const doc = pageDom.window.document

    // ── Overview / Description ──────────────────────────────────────────────
    const overviewEl =
        doc.querySelector('[id*="jd_product_overview"] .metafield-rich_text_field') ||
        doc.querySelector('[id*="jd_product_overview"] .overview-content-left')
    const description = overviewEl ? overviewEl.innerHTML.trim() : ''

    // ── Manuals ─────────────────────────────────────────────────────────────
    const manuals = Array.from(doc.querySelectorAll('[id*="jd_product_overview"] a[href]'))
        .filter((a) => {
            const href = a.getAttribute('href') || ''
            return href && (href.includes('.pdf') || href.includes('cdn.shopify'))
        })
        .map((a) => {
            const name =
                (a.textContent || '')
                    .trim()
                    .replace(/\.(pdf|PDF)$/, '')
                    .trim() || 'Manual'
            const href = a.getAttribute('href') || ''
            return `${name}:${href}`
        })

    // ── Features ────────────────────────────────────────────────────────────
    const features = []
    const featureItems = doc.querySelectorAll('.product-highlights-item')
    featureItems.forEach((item) => {
        const featureTitle = (item.querySelector('.title')?.textContent || '').trim()
        const featureText = (item.querySelector('.text')?.textContent || '').trim()
        if (featureTitle) {
            features.push(featureText ? `${featureTitle}: ${featureText}` : featureTitle)
        }
    })

    const pageData = { description, manuals, features }

    // Build standard checkmarks
    const checkmarks = [
        'Brand new',
        warranty || 'Factory warranty',
        'Manufacturer direct shipping from CA, NJ, IL, & TX',
        `Authorized ${VENDOR} dealer`,
    ]

    // Meta description
    const warrantyLong = warranty ? `This item comes with a ${warranty}.` : 'This item comes with a factory warranty.'
    const metaDescription = `${title}. Brand new. ${warrantyLong}. Authorized dealer. Free shipping, manufacturer direct.`

    return {
        Title: title,
        Description: pageData.description,
        Warranty: warrantyLong,
        Manuals: pageData.manuals,
        PackageContents: [],
        Checkmarks: checkmarks,
        Specifications: specifications,
        Features: pageData.features,
        MetaDescription: metaDescription,
        Media: media,
        Barcode: scrapedBarcode,
    }
}

// ── Image Helpers ───────────────────────────────────────────────────────────
const MIN_IMAGE_SIZE = 100
const IMAGE_FETCH_TIMEOUT_MS = 10000

async function filterSmallImages(mediaItems) {
    const results = await Promise.allSettled(
        mediaItems.map(async (item) => {
            try {
                const response = await fetch(item.originalSource, {
                    signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
                })
                if (!response.ok) {
                    console.log(`Filtering out image ${item.originalSource} — fetch returned ${response.status}`)
                    return null
                }
                const arrayBuffer = await response.arrayBuffer()
                const metadata = await sharp(Buffer.from(arrayBuffer)).metadata()
                if (metadata.width < MIN_IMAGE_SIZE || metadata.height < MIN_IMAGE_SIZE) {
                    console.log(
                        `Filtering out image ${item.originalSource} — dimensions ${metadata.width}x${metadata.height} below minimum`
                    )
                    return null
                }
                return item
            } catch (err) {
                console.error(`Failed to check dimensions for ${item.originalSource}:`, err.message)
                return null
            }
        })
    )
    return results.map((r) => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean)
}

async function removeBackground(imageBuffer) {
    const convertedImage = await sharp(imageBuffer).png().toBuffer()
    const response = await fetch('https://sdk.photoroom.com/v1/segment', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': PHOTOROOM_API_KEY,
        },
        body: JSON.stringify({
            image_file_b64: convertedImage.toString('base64'),
            crop: true,
        }),
    })
    if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        throw new Error(`Photoroom API error (${response.status}): ${errBody}`)
    }
    return response.blob()
}

const MIN_DIM = 1500
const MAX_DIM = 2000

async function resizeForShopify(inputBuffer) {
    let { data: buffer, info } = await sharp(inputBuffer)
        .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true })
    let { width, height } = info

    if (width < MIN_DIM || height < MIN_DIM) {
        let targetW, targetH
        if (width <= height) {
            targetW = MIN_DIM
            targetH = Math.round((height * MIN_DIM) / width)
        } else {
            targetH = MIN_DIM
            targetW = Math.round((width * MIN_DIM) / height)
        }
        if (targetW <= MAX_DIM && targetH <= MAX_DIM) {
            buffer = await sharp(buffer).resize(targetW, targetH, { fit: 'fill' }).toBuffer()
        } else {
            if (width >= height) {
                targetW = MAX_DIM
                targetH = Math.round((height * MAX_DIM) / width)
            } else {
                targetH = MAX_DIM
                targetW = Math.round((width * MAX_DIM) / height)
            }
            buffer = await sharp(buffer).resize(targetW, targetH, { fit: 'fill' }).toBuffer()
            const finalW = Math.max(targetW, MIN_DIM)
            const finalH = Math.max(targetH, MIN_DIM)
            const extendLeft = Math.floor((finalW - targetW) / 2)
            const extendRight = finalW - targetW - extendLeft
            const extendTop = Math.floor((finalH - targetH) / 2)
            const extendBottom = finalH - targetH - extendTop
            buffer = await sharp(buffer)
                .extend({
                    top: extendTop,
                    bottom: extendBottom,
                    left: extendLeft,
                    right: extendRight,
                    background: { r: 0, g: 0, b: 0, alpha: 0 },
                })
                .toBuffer()
        }
    }
    return sharp(buffer).webp({ quality: 50 }).toBuffer()
}

function getFileNameWithTimestamp(fileName, extension = '.png') {
    if (!fileName || typeof fileName !== 'string') throw new Error('Invalid file name!')
    const lastDot = fileName.lastIndexOf('.')
    const nameWithoutExtension = (lastDot > 0 ? fileName.substring(0, lastDot) : fileName)
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
    return `${nameWithoutExtension || 'image'}-${Date.now()}${extension}`
}

async function uploadToS3({ image, store_id, fileName, contentType = 'image/png' }) {
    const s3Key = `photoroom/${store_id}/${fileName}`
    const s3URL = `https://fpdash-bucket.s3.amazonaws.com/photoroom/${store_id}/${fileName}`
    await new Upload({
        client: S3,
        params: {
            Bucket: 'fpdash-bucket',
            Key: s3Key,
            Body: image,
            ContentType: contentType,
        },
    }).done()
    return s3URL
}

async function removeFirstImageBackground(imageUrls, store_id) {
    if (!imageUrls || imageUrls.length === 0) return
    const imageUrl = imageUrls[0]
    const response = await fetch(imageUrl)
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    let processedBuffer
    try {
        const imageBlob = await removeBackground(buffer)
        processedBuffer = Buffer.from(await imageBlob.arrayBuffer())
    } catch (err) {
        console.log(`[Photoroom] Background removal failed, using original image: ${err.message}`)
        processedBuffer = buffer
    }
    const resizedBuffer = await resizeForShopify(processedBuffer)
    console.log(`[Photoroom] Image resized and ready for upload`)
    const rawFileName = imageUrl.split('/').pop().split('?')[0]
    let decodedFileName = rawFileName
    try {
        decodedFileName = decodeURIComponent(rawFileName)
    } catch (_) {
        decodedFileName = rawFileName
    }
    const formattedFileName = getFileNameWithTimestamp(decodedFileName, '.webp')
    return uploadToS3({
        image: resizedBuffer,
        store_id,
        fileName: formattedFileName,
        contentType: 'image/webp',
    })
}

// ── Shopify Helpers ─────────────────────────────────────────────────────────
async function getPublications(storeInfo) {
    const result = await shopifyGraphQL(
        storeInfo,
        `query publications {
        publications(first: 100) {
            edges {
                node {
                    id
                    name
                }
            }
        }
    }`
    )
    return result.data.publications.edges.map((e) => e.node)
}

async function publishProduct(productGid, publications, storeInfo) {
    const result = await shopifyGraphQL(
        storeInfo,
        `mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
            publishablePublish(id: $id, input: $input) {
                publishable {
                    availablePublicationsCount { count }
                    resourcePublicationsCount { count }
                }
                userErrors { field message }
            }
        }`,
        {
            id: productGid,
            input: publications.map((p) => ({ publicationId: p.id })),
        }
    )
    if (result.data?.publishablePublish?.userErrors?.length > 0) {
        throw new Error(result.data.publishablePublish.userErrors[0].message)
    }
    return result
}

async function shopifyGraphQL(storeInfo, queryStr, variables) {
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
    return res.json()
}

async function uploadProductFile(storeInfo, originalSource) {
    const res = await shopifyGraphQL(
        storeInfo,
        `mutation fileCreate($files: [FileCreateInput!]!) {
            fileCreate(files: $files) {
                files { id }
                userErrors { field message }
            }
        }`,
        { files: { contentType: 'FILE', originalSource } }
    )
    if (res.errors) throw new Error(`GraphQL errors: ${JSON.stringify(res.errors)}`)
    if (res.data.fileCreate.userErrors.length > 0)
        throw new Error(`GraphQL user errors: ${JSON.stringify(res.data.fileCreate.userErrors)}`)
    return res.data.fileCreate.files
}

async function getFileUrl(storeInfo, fileId) {
    const res = await shopifyGraphQL(storeInfo, `{ node(id: "${fileId}") { ... on GenericFile { url } } }`)
    if (!res.data.node || !res.data.node.url) throw new Error('File URL not found in Shopify response!')
    return res.data.node.url
}

async function createShopifyProduct({ scrapedResult, product_type, vendor, sku, storeInfo, pool }) {
    const media =
        scrapedResult.Media?.map((m) => ({
            alt: m.alt,
            mediaContentType: m.mediaContentType,
            originalSource: m.originalSource,
        })) || []

    // Look up manuals from product_manuals table first
    let manuals = []
    if (sku) {
        try {
            const dbManuals = await getProductManuals(pool, sku)
            if (dbManuals.length > 0) {
                manuals = dbManuals.map((m) => ({
                    name: 'User Manual',
                    url: m.manual_url,
                }))
                console.log(`Found ${dbManuals.length} manual(s) in product_manuals table for SKU ${sku}`)
            }
        } catch (err) {
            console.error(`Failed to look up product_manuals for SKU ${sku}:`, err.message)
        }
    }
    // Fall back to scraped manuals
    if (manuals.length === 0) {
        manuals =
            scrapedResult.Manuals?.map((manual) => {
                const colonIdx = manual.indexOf(':')
                if (colonIdx === -1) return { name: 'Manual', url: manual }
                const name = manual.substring(0, colonIdx).trim()
                const url = manual.substring(colonIdx + 1).trim()
                return { name, url }
            }) || []
    }

    for (const manual of manuals) {
        if (!manual.url) continue
        const fileResult = await uploadProductFile(storeInfo, manual.url).catch((err) => {
            console.error(`Failed to upload manual: ${err.message}`)
        })
        if (!fileResult || fileResult.length === 0) {
            console.error(`Failed to upload manual ${manual.name} for product ${scrapedResult.Title}`)
            continue
        }
        let fileUrl
        let retryCount = 0
        const maxRetries = 6
        while (!fileUrl && retryCount < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, 3000))
            try {
                fileUrl = await getFileUrl(storeInfo, fileResult[0].id)
            } catch (err) {
                console.error(
                    `Attempt ${retryCount + 1} - Failed to get file URL for manual ${manual.name}:`,
                    err.message
                )
                retryCount++
            }
        }
        if (fileUrl) {
            manual.url = fileUrl
        } else {
            delete manual.url
        }
    }

    const uploadedManuals = manuals.filter((m) => m.url).map((m) => `${m.name}:${m.url}`)

    const needsReview =
        !scrapedResult.PackageContents ||
        scrapedResult.PackageContents.length === 0 ||
        (scrapedResult.Features || []).join('').length < 200 ||
        uploadedManuals.length === 0 ||
        !media.length

    const tags = [
        needsReview ? 'Needs Review' : null,
        !scrapedResult.PackageContents || scrapedResult.PackageContents.length === 0
            ? 'Review: Package Contents'
            : null,
        (scrapedResult.Features || []).join('').length < 200 ? 'Review: Features' : null,
        uploadedManuals.length === 0 ? 'Review: Manuals' : null,
        !media.length ? 'Review: Images' : null,
    ]

    const product = {
        title: scrapedResult.Title,
        descriptionHtml: scrapedResult.Description,
        productType: product_type,
        vendor,
        status: !media.length ? 'DRAFT' : 'ACTIVE',
        seo: { description: scrapedResult.MetaDescription },
        tags: ['new', 'MechMaxx Lister', ...tags.filter(Boolean)],
        metafields: [
            {
                namespace: 'custom',
                key: 'warranty',
                value: scrapedResult.Warranty,
                type: 'single_line_text_field',
            },
            {
                namespace: 'custom',
                key: 'manuals',
                value: JSON.stringify(uploadedManuals),
                type: 'list.single_line_text_field',
            },
            {
                namespace: 'custom',
                key: 'package_contents',
                value: JSON.stringify(scrapedResult.PackageContents || []),
                type: 'list.single_line_text_field',
            },
            {
                namespace: 'custom',
                key: 'checkmarks',
                value: JSON.stringify(scrapedResult.Checkmarks),
                type: 'list.single_line_text_field',
            },
            {
                namespace: 'custom',
                key: 'specifications',
                value: JSON.stringify(scrapedResult.Specifications),
                type: 'list.single_line_text_field',
            },
            {
                namespace: 'custom',
                key: 'features',
                value: JSON.stringify(scrapedResult.Features),
                type: 'list.single_line_text_field',
            },
        ],
    }

    return shopifyGraphQL(
        storeInfo,
        `
        mutation productCreate($media: [CreateMediaInput!], $product: ProductCreateInput) {
            productCreate(media: $media, product: $product) {
                product {
                    id
                    title
                    variants(first: 1) {
                        nodes { id }
                    }
                }
                userErrors { field message }
            }
        }
    `,
        { media, product }
    )
}

async function updateVariant(
    { productGid, variantGid, price, unit_cost, sku, barcode, weight, weightUnit, tracked = false, metafields = [] },
    storeInfo
) {
    const normalizedMetafields = metafields
        .filter((mf) => mf.value !== undefined && mf.value !== null)
        .map((mf) => ({
            ...mf,
            value: typeof mf.value === 'string' ? mf.value : String(mf.value),
        }))
    const variantInput = {
        id: variantGid,
        price,
        barcode,
        taxable: true,
        inventoryItem: { cost: unit_cost, sku, tracked },
        metafields: normalizedMetafields,
    }
    // Note: weight/weightUnit are not valid on ProductVariantsBulkInput in the GraphQL API.
    // Shipping weight is stored in the custom_shipping_weight metafield instead.
    const res = await shopifyGraphQL(
        storeInfo,
        `
        mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                userErrors { field message }
            }
        }
    `,
        {
            productId: productGid,
            variants: [variantInput],
        }
    )
    if (res.errors) throw new Error(`GraphQL errors: ${JSON.stringify(res.errors)}`)
    if (res.data.productVariantsBulkUpdate.userErrors.length > 0)
        throw new Error(`GraphQL user errors: ${JSON.stringify(res.data.productVariantsBulkUpdate.userErrors)}`)
    return res.data.productVariantsBulkUpdate
}

async function createListingEvent(pool, event) {
    const keys = Object.keys(event).filter((k) => event[k] !== undefined)
    const values = keys.map((k) => {
        const v = event[k]
        return typeof v === 'object' && v !== null ? JSON.stringify(v) : v
    })
    return query(
        pool,
        `INSERT INTO product_listing_events(${keys.join(', ')})
         VALUES (${keys.map(() => '?').join(', ')})`,
        values
    )
}

// ── Filter Generation ───────────────────────────────────────────────────────
async function syncFilterValues() {
    try {
        await fetch(`${FPHOOKS_ENDPOINT}/sync/filters`, {
            headers: {
                Authorization: jwt.sign({ server: true }, process.env.JWT_SECRET),
            },
        }).catch((err) => err.message)
    } catch (err) {
        console.error('Failed to sync filter values:', err.message)
    }
}

async function generateFiltersForNewProduct({ pool, productId, productType, productData }) {
    try {
        const filterGroups = await query(
            pool,
            `
            SELECT DISTINCT fg.id, fg.name, fg.type, fg.unit
            FROM product_filter_values_new pfv
            JOIN filter_groups fg ON fg.id = pfv.filter_group_id
            JOIN products p ON p.id = pfv.product_id
            WHERE p.product_type = ?
            `,
            [productType]
        )

        if (!filterGroups.length) {
            console.log(`No existing filter groups found for product type "${productType}", skipping filter generation`)
            return null
        }

        const product = {
            id: productId,
            title: productData.title,
            custom_specifications: productData.specifications || null,
            custom_features: productData.features || null,
        }

        const filter_groups = []
        for (const fg of filterGroups) {
            const existingValues = await query(
                pool,
                `SELECT DISTINCT pfv.value
                 FROM product_filter_values_new pfv
                 JOIN products p ON p.id = pfv.product_id
                 WHERE pfv.filter_group_id = ? AND p.product_type = ?
                 LIMIT 50`,
                [fg.id, productType]
            )
            filter_groups.push({
                name: fg.name,
                type: fg.type,
                unit: fg.unit || '',
                previousValues: existingValues.map((r) => r.value),
            })
        }

        console.log(
            `Generating filters for new product ${productId} (type: ${productType}) with ${filter_groups.length} filter groups`
        )

        const response = await openai.responses.create({
            model: 'gpt-5.4',
            tools: [{ type: 'web_search' }],
            input: `I am generating filters for a collection page by product type.
                I will give you a json objects that has rows of products with id, title, specs, and features.
                I will also give you a list of filter groups.
                Use the specs, title, and features to find the filter values for each filter group.
                if you cant find a value, do a web search of the product title to find these details for each filter that is missing values, we want good coverage.
                I need filter values based on the specifications for each product id that fit into the filter groups.
                Give me an array of objects like { filterGroup: string; filterValue: string, productId: number } for each product id.
                If the filter values are numeric it should just be 1 number, if its more of a feature then minimum number of words to describe it.
                The goal is filtering so if something has more or less the same value for a filter group then it should be in the same filter value.
                The filter groups that are not ranges have previous values that have been used for other products, try to reuse those values if it makes sense to create consistency across products.
                If the filter group is a range the filter value can just be the number.
                If it exists, use the features group sparingly, we only want at most 5 different features
                dont include \`\`\`json in the output text
                dont include comments because I am json parsing the output

                Here is the product: ${JSON.stringify(product)}
                Here are the filter groups: ${JSON.stringify(filter_groups)}
                `,
        })

        const parsed = JSON.parse(response.output_text)
        console.log(`Got AI filter response for new product ${productId}`)

        const filterGroupIdCache = {}
        for (const filterValue of parsed) {
            if (!filterGroupIdCache[filterValue.filterGroup]) {
                const rows = await query(pool, 'SELECT id FROM filter_groups WHERE name = ?', [filterValue.filterGroup])
                filterGroupIdCache[filterValue.filterGroup] = rows[0]?.id || null
            }

            if (filterGroupIdCache[filterValue.filterGroup]) {
                await query(
                    pool,
                    'INSERT IGNORE INTO product_filter_values_new (product_id, filter_group_id, value, store_id) VALUES (?, ?, ?, ?)',
                    [productId, filterGroupIdCache[filterValue.filterGroup], filterValue.filterValue, 1]
                )
            } else {
                console.error(`Filter group not found for name: ${filterValue.filterGroup}`)
            }
        }

        await syncFilterValues()

        console.log(`Successfully generated ${parsed.length} filter values for new product ${productId}`)
        return parsed
    } catch (error) {
        console.error(`Failed to generate filters for new product ${productId}: ${error.message}`)
        return null
    }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const pool = createPool()

    try {
        // 1. Load the MechMaxx CSV
        console.log('Loading Mech Maxx product CSV...')
        const csvPath = new URL('./Mech_Maxx_product_import_template.csv', import.meta.url)
        const csvContent = fs.readFileSync(csvPath, 'utf-8')
        const csvRows = parse(csvContent, {
            columns: true,
            skip_empty_lines: true,
            relax_column_count: true,
        })

        // Filter by product type if specified
        const filteredRows = csvRows.filter((row) => {
            const productType = row['Product Type']?.trim()
            if (!productType) return false
            if (PRODUCT_TYPE_FILTER && productType !== PRODUCT_TYPE_FILTER) return false
            const url = row['Manufacturer Weblink']?.trim()
            return !!url
        })

        console.log(
            `Found ${filteredRows.length} products in CSV${PRODUCT_TYPE_FILTER ? ` matching "${PRODUCT_TYPE_FILTER}"` : ''}`
        )

        if (filteredRows.length === 0) {
            console.log('No products found. Exiting.')
            return
        }

        // 2. Get store info
        const storeInfo = await getStoreInfo(pool)
        console.log(`Using store: ${storeInfo.shopify_name}`)

        // 3. Get already-listed Mech Maxx SKUs from DB
        console.log('Loading already-listed Mech Maxx SKUs from database...')
        const listedSkuRows = await query(
            pool,
            `SELECT vn.sku FROM variants_new vn
             JOIN products p ON p.id = vn.product_id
             WHERE p.vendor = ? AND vn.sku IS NOT NULL AND p.store_id = ?`,
            [VENDOR, STORE_ID]
        )
        const listedSkuSet = new Set(listedSkuRows.map((r) => r.sku))
        console.log(`${listedSkuSet.size} SKUs already listed`)

        // 4. Filter out already-listed SKUs
        const toProcess = filteredRows.filter((row) => {
            const sku = row['Shopify SKU']?.trim()
            return sku && !listedSkuSet.has(sku)
        })

        console.log(
            `${toProcess.length} unlisted product(s) to process (${listedSkuSet.size} excluded as already listed)`
        )
        if (toProcess.length === 0) {
            console.log('Nothing to list. Exiting.')
            return
        }

        // 5. Get brand-level product setup defaults (checkmarks, warranty, manuals overrides)
        let brandDefaults = null
        try {
            const [defaults] = await getProductSetupDefaults(pool, VENDOR)
            if (defaults) {
                brandDefaults = {
                    checkmarks: defaults.checkmarks
                        ? typeof defaults.checkmarks === 'string'
                            ? JSON.parse(defaults.checkmarks)
                            : defaults.checkmarks
                        : null,
                    warranty: defaults.warranty || null,
                    manuals: defaults.manuals
                        ? typeof defaults.manuals === 'string'
                            ? JSON.parse(defaults.manuals)
                            : defaults.manuals
                        : null,
                }
                console.log('Loaded Mech Maxx brand defaults (checkmarks, warranty, manuals)')
            }
        } catch (err) {
            console.warn('Could not load brand defaults:', err.message)
        }

        // 6. Get publications (sales channels)
        const publications = await getPublications(storeInfo).catch((err) => {
            console.error('Failed to retrieve publications:', err.message)
            return []
        })
        console.log(`Found ${publications.length} sales channel(s)`)

        // 7. List products
        const toList = toProcess.slice(0, LIMIT)
        console.log(`\nListing ${toList.length} product(s) with concurrency ${CONCURRENCY}...\n`)

        let successCount = 0
        let failCount = 0

        async function listOneProduct(row) {
            const supplierSku = row['Shopify SKU']?.trim()
            const modelNumber = row['Model Number']?.trim() || supplierSku
            const csvUpc = row['UPC']?.trim() || ''
            const productUrl = row['Manufacturer Weblink']?.trim()
            const productType = row['Product Type']?.trim()
            const shippingWeight = parseFloat((row['Shipping Weight'] || '').replace(/[^0-9.]/g, '')) || 0
            const shippingLength = parseFloat((row['Shipping Length'] || '').replace(/[^0-9.]/g, '')) || 0
            const shippingWidth = parseFloat((row['Shipping Width'] || '').replace(/[^0-9.]/g, '')) || 0
            const shippingHeight = parseFloat((row['Shipping Height'] || '').replace(/[^0-9.]/g, '')) || 0
            const shippingFee = parseFloat((row['Shipping Fee'] || '').replace(/[^0-9.]/g, '')) || 0
            const shippingClass = (row['Shipping Class'] || '').trim()
            const shippingNmfc = (row['Shipping NMFC'] || '').trim()
            const shippingSub = (row['Shipping Sub'] || '').trim()
            const shippingAdditionalInfo = (row['Shipping Additional Info'] || '').trim()
            const shippingMethod = (row['Shipping Method'] || '').trim()
            const costRaw = parseFloat((row['Cost'] || '').replace(/[^0-9.]/g, '')) || 0
            const mapPrice = parseFloat((row['MAP Price'] || '').replace(/[^0-9.]/g, '')) || 0
            const msrp = parseFloat((row['MSRP'] || '').replace(/[^0-9.]/g, '')) || 0
            // Lowest Price is the floor/MAP; fall back to MAP Price then MSRP
            const priceRaw = parseFloat((row['Lowest Price'] || '').replace(/[^0-9.]/g, '')) || mapPrice || msrp || 0
            const price = priceRaw
            const cost = costRaw

            console.log(`[${supplierSku}] Starting... (${productUrl})`)

            // Scrape product data from MechMaxx site
            const scrapedResult = await scrapeProductData(productUrl)

            // CSV UPC takes priority; fall back to barcode scraped from product JSON
            const upc = csvUpc || scrapedResult.Barcode || ''

            // AI-generate title using scraped title + model number as input
            const aiTitle = await generateTitle({
                scrapedTitle: scrapedResult.Title,
                modelNumber,
                productType,
            })
            scrapedResult.Title = aiTitle
            scrapedResult.MetaDescription = `${aiTitle}. Brand new. ${scrapedResult.Warranty}. Authorized dealer. Free shipping, manufacturer direct.`

            console.log(`[${supplierSku}] Title: "${scrapedResult.Title}"`)
            console.log(
                `[${supplierSku}] Features: ${scrapedResult.Features.length}, Specs: ${scrapedResult.Specifications.length}, Manuals: ${scrapedResult.Manuals.length}`
            )

            // Apply brand defaults if set
            if (brandDefaults) {
                if (brandDefaults.checkmarks?.length) scrapedResult.Checkmarks = brandDefaults.checkmarks
                if (brandDefaults.warranty?.length) scrapedResult.Warranty = brandDefaults.warranty
                if (brandDefaults.manuals?.length) scrapedResult.Manuals = brandDefaults.manuals
            }

            // Filter out small images
            scrapedResult.Media = await filterSmallImages(scrapedResult.Media)

            // Remove background from first image and upload to S3
            const firstImageUrl = await removeFirstImageBackground(
                scrapedResult.Media?.map((m) => m.originalSource),
                STORE_ID
            ).catch((err) => {
                console.error(`[${supplierSku}] Failed to remove background: ${err.message}`)
                return null
            })
            if (scrapedResult.Media?.[0] && firstImageUrl) {
                scrapedResult.Media[0].originalSource = firstImageUrl
            }

            // Create product on Shopify
            const createResponse = await createShopifyProduct({
                scrapedResult,
                product_type: productType,
                vendor: VENDOR,
                sku: supplierSku,
                storeInfo,
                pool,
            })

            if (createResponse.data?.productCreate?.userErrors?.length > 0) {
                console.error(`[${supplierSku}] Shopify errors:`, createResponse.data.productCreate.userErrors)
                throw new Error('Shopify product creation failed')
            }

            const createdProduct = createResponse.data?.productCreate?.product
            if (!createdProduct) {
                console.error(`[${supplierSku}] No product returned:`, JSON.stringify(createResponse))
                throw new Error('No product returned from Shopify')
            }

            console.log(`[${supplierSku}] ✓ Created: ${createdProduct.title} (${createdProduct.id})`)

            // Insert stripped product row for FK constraints
            const numericProductId = parseInt(createdProduct.id.split('/').pop())
            await query(
                pool,
                `INSERT IGNORE INTO products (id, title, product_type, vendor, status, store_id, custom_specifications, custom_features)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    numericProductId,
                    createdProduct.title,
                    productType,
                    VENDOR,
                    'draft',
                    STORE_ID,
                    JSON.stringify(scrapedResult.Specifications || []),
                    JSON.stringify(scrapedResult.Features || []),
                ]
            ).catch((err) => {
                console.error(`[${supplierSku}] Failed to insert stripped product row:`, err.message)
            })

            // Publish to sales channels
            if (publications.length > 0) {
                await publishProduct(createdProduct.id, publications, storeInfo).catch((err) => {
                    console.error(`[${supplierSku}] Failed to publish to sales channels:`, err.message)
                })
                console.log(`[${supplierSku}] ✓ Published to ${publications.length} sales channel(s)`)
            }

            // Update variant with price, cost, model number as SKU, shipping fields
            const variantGid = createdProduct.variants?.nodes?.[0]?.id
            if (variantGid) {
                await updateVariant(
                    {
                        productGid: createdProduct.id,
                        variantGid,
                        price: String(price),
                        unit_cost: String(cost),
                        sku: supplierSku,
                        barcode: upc,
                        weight: shippingWeight || undefined,
                        weightUnit: shippingWeight ? 'POUNDS' : undefined,
                        tracked: true,
                        metafields: [
                            { namespace: 'custom', key: 'upc', value: upc, type: 'single_line_text_field' },
                            {
                                namespace: 'custom',
                                key: 'supplier_sku',
                                value: supplierSku,
                                type: 'single_line_text_field',
                            },
                            {
                                namespace: 'custom',
                                key: 'supplier_model_number',
                                value: modelNumber,
                                type: 'single_line_text_field',
                            },
                            {
                                namespace: 'custom',
                                key: 'projected_unit_cost',
                                value: String(cost),
                                type: 'single_line_text_field',
                            },
                            {
                                namespace: 'custom',
                                key: 'projected_price',
                                value: String(price),
                                type: 'single_line_text_field',
                            },
                            shippingFee
                                ? {
                                      namespace: 'custom',
                                      key: 'projected_shipping_fee',
                                      value: String(shippingFee),
                                      type: 'single_line_text_field',
                                  }
                                : null,
                            mapPrice
                                ? {
                                      namespace: 'custom',
                                      key: 'map_price',
                                      value: String(mapPrice),
                                      type: 'single_line_text_field',
                                  }
                                : null,
                            msrp
                                ? {
                                      namespace: 'custom',
                                      key: 'msrp',
                                      value: String(msrp),
                                      type: 'single_line_text_field',
                                  }
                                : null,
                            {
                                namespace: 'custom',
                                key: 'weblinks',
                                value: JSON.stringify([{ link: productUrl, title: 'Manufacturer Website' }]),
                                type: 'json',
                            },
                            shippingWeight
                                ? {
                                      namespace: 'custom',
                                      key: 'shipping_weight',
                                      value: String(shippingWeight),
                                      type: 'single_line_text_field',
                                  }
                                : null,
                            shippingWeight
                                ? {
                                      namespace: 'custom',
                                      key: 'shipping_weight_unit',
                                      value: 'lbs',
                                      type: 'single_line_text_field',
                                  }
                                : null,
                            shippingLength
                                ? {
                                      namespace: 'custom',
                                      key: 'shipping_length',
                                      value: String(shippingLength),
                                      type: 'single_line_text_field',
                                  }
                                : null,
                            shippingWidth
                                ? {
                                      namespace: 'custom',
                                      key: 'shipping_width',
                                      value: String(shippingWidth),
                                      type: 'single_line_text_field',
                                  }
                                : null,
                            shippingHeight
                                ? {
                                      namespace: 'custom',
                                      key: 'shipping_height',
                                      value: String(shippingHeight),
                                      type: 'single_line_text_field',
                                  }
                                : null,
                            shippingClass
                                ? {
                                      namespace: 'custom',
                                      key: 'shipping_class',
                                      value: shippingClass,
                                      type: 'single_line_text_field',
                                  }
                                : null,
                            shippingNmfc
                                ? {
                                      namespace: 'custom',
                                      key: 'shipping_nmfc',
                                      value: shippingNmfc,
                                      type: 'single_line_text_field',
                                  }
                                : null,
                            shippingSub
                                ? {
                                      namespace: 'custom',
                                      key: 'shipping_sub',
                                      value: shippingSub,
                                      type: 'single_line_text_field',
                                  }
                                : null,
                            shippingAdditionalInfo
                                ? {
                                      namespace: 'custom',
                                      key: 'shipping_additional_info',
                                      value: shippingAdditionalInfo,
                                      type: 'single_line_text_field',
                                  }
                                : null,
                            shippingMethod
                                ? {
                                      namespace: 'custom',
                                      key: 'shipping_method',
                                      value: shippingMethod,
                                      type: 'single_line_text_field',
                                  }
                                : null,
                        ].filter(Boolean),
                    },
                    storeInfo
                )
                console.log(
                    `[${supplierSku}] ✓ Variant updated (price: $${price}, cost: $${cost}, sku: ${supplierSku})`
                )
            }

            // Record listing event
            await createListingEvent(pool, {
                product_id: createdProduct.id.split('/').pop(),
                event_type: 'PRODUCT_LISTED',
                event_data: JSON.stringify({
                    source: 'MECHMAXX_LISTER_SCRIPT',
                    sku: supplierSku,
                    model_number: modelNumber,
                    product_type: productType,
                    price: String(price),
                    unit_cost: String(cost),
                }),
                store_id: STORE_ID,
            }).catch((err) => {
                console.error(`[${supplierSku}] Failed to create listing event:`, err.message)
            })

            // Generate AI filters
            await generateFiltersForNewProduct({
                pool,
                productId: numericProductId,
                productType,
                productData: {
                    title: createdProduct.title,
                    specifications: scrapedResult.Specifications,
                    features: scrapedResult.Features,
                },
            })
                .then((result) => {
                    if (result) console.log(`[${supplierSku}] ✓ Generated ${result.length} filter values`)
                })
                .catch((err) => {
                    console.error(`[${supplierSku}] Failed to generate filters:`, err.message)
                })
        }

        // Process in batches of CONCURRENCY
        for (let i = 0; i < toList.length; i += CONCURRENCY) {
            const batch = toList.slice(i, i + CONCURRENCY)
            const batchNum = Math.floor(i / CONCURRENCY) + 1
            const totalBatches = Math.ceil(toList.length / CONCURRENCY)
            console.log(`\n── Batch ${batchNum}/${totalBatches} (${batch.length} products) ──\n`)

            const results = await Promise.allSettled(batch.map((row) => listOneProduct(row)))
            for (const r of results) {
                if (r.status === 'fulfilled') successCount++
                else {
                    failCount++
                    console.error('Product failed:', r.reason?.message || r.reason)
                }
            }
        }

        console.log(`\n✓ Done! ${successCount} succeeded, ${failCount} failed.`)
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
