import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import fs from 'fs'
import sharp from 'sharp'
import OpenAI from 'openai'
import mysql from 'mysql'
import { parse } from 'csv-parse/sync'
import { S3 as AWSS3, GetObjectCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import jwt from 'jsonwebtoken'

// ── Config ──────────────────────────────────────────────────────────────────
const PHOTOROOM_API_KEY = process.env.PHOTOROOM_API_KEY
const FPHOOKS_ENDPOINT = process.env.MODE === 'production' ? 'https://www.fphooks.com' : 'http://localhost:8081'
const COSTWAY_DISCOUNT = 0.8
const STORE_ID = 1
const PRODUCT_TYPE_FILTER = process.argv[2] && process.argv[2] !== 'null' ? process.argv[2] : null
const LIMIT = parseInt(process.argv[3]) || 10
const CONCURRENCY = parseInt(process.argv[4]) || 20
const SHOPIFY_API_VERSION = '2026-01'

const S3_BUCKET = 'fpdash-bucket'
const S3_PRODUCT_PREFIX = 'costwaydata'
const S3_PARENTS_PREFIX = 'costwaydata/configurableParents'

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

async function getAiListerPrompt(pool, vendor) {
    return query(
        pool,
        `SELECT p.id, p.company_id, p.prompt
         FROM ${STORE_ID}_company_ai_lister_prompts p
         JOIN companies c ON c.id = p.company_id
         WHERE c.shopify_vendor_name = ?`,
        [vendor]
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

// ── S3 Data Fetching ────────────────────────────────────────────────────────
async function fetchProductFromS3(fepId) {
    try {
        const res = await S3.send(
            new GetObjectCommand({
                Bucket: S3_BUCKET,
                Key: `${S3_PRODUCT_PREFIX}/${fepId}`,
            })
        )
        const body = await res.Body.transformToString()
        return JSON.parse(body)
    } catch (err) {
        if (err.name === 'NoSuchKey') return null
        throw err
    }
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

// ── Data Formatters ─────────────────────────────────────────────────────────
function stripHtml(html) {
    if (!html) return ''
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?(p|li|tr|td|th|div|ul|ol|table|tbody|thead|strong|em|span|a)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\u003C/g, '<')
        .replace(/\u003E/g, '>')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function parseSpecifications(specsHtml) {
    if (!specsHtml) return []
    const specs = []
    const rowRegex = /<tr[^>]*>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<\/tr>/gi
    let match
    while ((match = rowRegex.exec(specsHtml)) !== null) {
        const key = stripHtml(match[1])
            .trim()
            .replace(/\n/g, ' ')
            .replace(/[;:]+$/, '')
            .trim()
        const rawValue = stripHtml(match[2]).trim().replace(/\n/g, ' ')
        // Strip leading colon/semicolon that Costway sometimes includes
        const value = rawValue.replace(/^[;:\s]+/, '').trim()
        if (!value) continue
        if (key) {
            specs.push(`${key}::${value}`)
        } else if (specs.length > 0) {
            // Continuation row (empty key) — append to previous spec value
            specs[specs.length - 1] += `, ${value}`
        }
    }
    return specs
}

function parseFeatures(keyFeaturesHtml) {
    if (!keyFeaturesHtml) return []
    const features = []
    // Try splitting by <li> tags first
    const liMatches = keyFeaturesHtml.match(/<li[^>]*>([\s\S]*?)<\/li>/gi)
    if (liMatches && liMatches.length > 1) {
        for (const li of liMatches) {
            const cleaned = stripHtml(li)
                .replace(/[\n\r]+/g, ' ')
                .replace(/^[•●■▪\-–—]\s*/, '')
                .trim()
            if (cleaned.length > 10) {
                features.push(cleaned)
            }
        }
        return features
    }
    // Fall back to splitting by <br />
    const lines = keyFeaturesHtml
        .split(/<br\s*\/?>/gi)
        .map((line) => stripHtml(line).trim())
        .filter(Boolean)

    for (const line of lines) {
        // Remove leading bullet character
        const cleaned = line
            .replace(/^[•●■▪\-–—]\s*/, '')
            .trim()
            .replace(/\n/g, ' ')
        if (cleaned.length > 10) {
            features.push(cleaned)
        }
    }
    return features
}

function parseDescription(descriptionHtml) {
    if (!descriptionHtml) return ''
    const lines = descriptionHtml
        .split(/<br\s*\/?>/gi)
        .map((line) =>
            stripHtml(line)
                .replace(/^[•●■▪\-–—]\s*/, '')
                .trim()
        )
        .filter(Boolean)
    return lines.join('. ').replace(/\.\./g, '.').slice(0, 500)
}

function getGalleryImages(s3Data) {
    // Prefer the first variant's gallery if it has images, otherwise check parent
    const variant = s3Data.relation?.[0]
    const gallery = variant?.gallery || s3Data.gallery || []

    if (gallery.length === 0) return []

    return gallery
        .filter((img) => img.original_image)
        .slice(0, 10)
        .map((img) => ({
            alt: img.label || img.alt || '',
            mediaContentType: 'IMAGE',
            originalSource: img.original_image,
        }))
}

function getProductUrl(itemLink) {
    if (!itemLink) return ''
    try {
        const url = new URL(itemLink)
        // Strip tracking params, keep clean URL
        return `${url.origin}${url.pathname}`
    } catch {
        return itemLink
    }
}

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

// Parse costway option field (string "Color: Black", object, or plain value)
function parseOptionLabel(optionField) {
    if (!optionField) return { name: 'Option', value: 'Default' }
    if (typeof optionField === 'string') {
        const colonIdx = optionField.indexOf(':')
        if (colonIdx > 0) {
            return {
                name: optionField.substring(0, colonIdx).trim(),
                value: optionField.substring(colonIdx + 1).trim(),
            }
        }
        return { name: 'Option', value: optionField.trim() }
    }
    if (typeof optionField === 'object') {
        if (optionField.label != null && optionField.value != null) {
            return { name: String(optionField.label), value: String(optionField.value) }
        }
        const keys = Object.keys(optionField)
        if (keys.length > 0) return { name: keys[0], value: String(optionField[keys[0]]) }
    }
    return { name: 'Option', value: String(optionField) }
}

// ── Prompts ─────────────────────────────────────────────────────────────────
const titlePrompt = `Generate a product title and package contents for an authorized dealer listing.

Title Rules:
- [brand] [product title] [item_no] New
- The product title words can be SEO optimized and reordered and lessened if needed
- Truncate units: 'inches' to '"', 'feet' to "'", 'pounds' to 'lbs', etc.

{"title": "..."}

Product Data:
{PRODUCT_DATA}
`

// ── Warranty Parser ─────────────────────────────────────────────────────────
function parseWarranty(warrantyContent, warrantyInfo) {
    // Try to extract days from warranty_info or warranty_content
    const text = warrantyInfo || warrantyContent || ''
    const daysMatch = text.match(/(\d+)[- ]?[Dd]ay/)
    if (daysMatch) {
        const days = parseInt(daysMatch[1])
        if (days >= 365) {
            const years = Math.round(days / 365)
            return `This item comes with a ${years} year warranty.`
        }
        if (days >= 30) {
            const months = Math.round(days / 30)
            return `This item comes with a ${months} month warranty.`
        }
        return `This item comes with a ${days} day warranty.`
    }
    const monthMatch = text.match(/(\d+)[- ]?[Mm]onth/)
    if (monthMatch) {
        const months = parseInt(monthMatch[1])
        if (months >= 12) {
            return `This item comes with a ${Math.round(months / 12)} year warranty.`
        }
        return `This item comes with a ${months} month warranty.`
    }
    const yearMatch = text.match(/(\d+)[- ]?[Yy]ear/)
    if (yearMatch) {
        return `This item comes with a ${yearMatch[1]} year warranty.`
    }
    // Default for Costway (365-day standard)
    return 'This item comes with a 1 year warranty.'
}

// ── Listing Builder (data-driven, no AI except title) ───────────────────────
function buildListingFromData(s3Data, productType, title) {
    const warranty = parseWarranty(s3Data.warranty_content, s3Data.warranty_info)

    // Description: prefer full description, fall back to short_description
    let description = ''
    if (s3Data.texts?.description) {
        description = stripHtml(s3Data.texts.description)
            .replace(/(\s*\n\s*)+/g, '\n')
            .replace(/\n/g, '<br>')
    }
    if (!description && s3Data.texts?.short_description) {
        description = stripHtml(s3Data.texts.short_description)
            .replace(/(\s*\n\s*)+/g, '\n')
            .replace(/\n/g, '<br>')
    }

    // Specifications from HTML table
    const allSpecifications = parseSpecifications(s3Data.texts?.specifications)

    // Separate Package Includes rows from the rest of specs
    const packageContents = []
    const specifications = allSpecifications.filter((spec) => {
        const sepIdx = spec.indexOf('::')
        if (sepIdx === -1) return true
        const key = spec.slice(0, sepIdx).trim()
        if (/^package includes?$/i.test(key)) {
            const value = spec.slice(sepIdx + 2)
            value.split(',').forEach((item) => {
                const trimmed = item.trim()
                if (trimmed) packageContents.push(trimmed)
            })
            return false
        }
        return true
    })

    // Features from key_features HTML
    const features = parseFeatures(s3Data.texts?.key_features)

    // Manuals from instructions_pdf
    const manuals = s3Data.instructions_pdf ? [`User Manual:${s3Data.instructions_pdf}`] : []

    // Checkmarks - template with warranty
    const checkmarks = [
        'Brand new',
        warranty.replace('This item comes with a ', '').replace('.', '') + ' factory warranty',
        'Manufacturer direct shipping from NJ, CA, IL, GA, TX, WA, & GA',
        'Authorized Costway dealer',
    ]

    // MetaDescription
    const metaDescription = `${title}. Brand new. ${warranty.replace('This item comes with a ', '').replace(' warranty.', '')} warranty. Authorized dealer. Free shipping, manufacturer direct.`

    // Images from gallery
    const media = getGalleryImages(s3Data)

    return {
        Title: title,
        Description: description,
        Warranty: warranty,
        Manuals: manuals,
        Checkmarks: checkmarks,
        Specifications: specifications,
        PackageContents: packageContents,
        Features: features,
        MetaDescription: metaDescription,
        Media: media,
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
                        `Filtering out image ${item.originalSource} — dimensions ${metadata.width}x${metadata.height} below ${MIN_IMAGE_SIZE}x${MIN_IMAGE_SIZE} minimum`
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

async function fetchImageWithRetry(url, maxRetries = 4) {
    let delay = 1000
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(15000),
            })
            if (res.ok) {
                const buffer = Buffer.from(await res.arrayBuffer())
                const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg'
                return { buffer, contentType }
            }
            if (res.status === 429 && attempt < maxRetries) {
                console.log(`  CDN 429, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`)
                await new Promise((r) => setTimeout(r, delay))
                delay *= 2
                continue
            }
            throw new Error(`HTTP ${res.status}`)
        } catch (err) {
            if (attempt >= maxRetries) throw err
            await new Promise((r) => setTimeout(r, delay))
            delay *= 2
        }
    }
}

async function removeFirstImageBackground(imageUrls, store_id) {
    if (!imageUrls || imageUrls.length === 0) return
    const imageUrl = imageUrls[0]
    const { buffer } = await fetchImageWithRetry(imageUrl)
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
    const rawFileName = imageUrl.split('/').pop()
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

async function uploadGalleryImage(url, store_id) {
    const { buffer, contentType } = await fetchImageWithRetry(url)
    const ext = contentType === 'image/png' ? '.png' : contentType === 'image/webp' ? '.webp' : '.jpg'
    const rawFileName = url.split('/').pop().split('?')[0]
    let decodedFileName
    try {
        decodedFileName = decodeURIComponent(rawFileName)
    } catch {
        decodedFileName = rawFileName
    }
    const formattedFileName = getFileNameWithTimestamp(decodedFileName, ext)
    return uploadToS3({ image: buffer, store_id, fileName: formattedFileName, contentType })
}

// ── AI Generation (title only) ──────────────────────────────────────────────
function buildProductDataForAI(s3Data, productType) {
    const data = {
        brand: 'Costway',
        item_no: s3Data.item_no,
        product_type: productType,
        name: s3Data.name,
        description: stripHtml(s3Data.texts?.short_description || s3Data.texts?.description || ''),
        categories: s3Data.category_list || [],
    }
    return JSON.stringify(data, null, 2)
}

async function generateListingObject({ s3Data, productType, additional_prompt }) {
    const productDataStr = buildProductDataForAI(s3Data, productType)
    let finalPrompt = titlePrompt.replace('{PRODUCT_DATA}', productDataStr)
    if (additional_prompt) {
        finalPrompt += `\nAdditional Instructions:\n${additional_prompt}\n`
    }

    const titleResponse = await openai.responses.create({
        model: 'gpt-5.4',
        input: finalPrompt,
    })

    let title = ''
    try {
        const parsed = JSON.parse(titleResponse.output_text.trim())
        title = parsed.title || ''
    } catch {
        // Fallback: treat entire response as title (old behavior)
        title = titleResponse.output_text.trim().replace(/^["']|["']$/g, '')
    }
    console.log(`  AI generated title: ${title}`)

    // Build the full listing object from data (no AI needed for these)
    const listing = buildListingFromData(s3Data, productType, title)

    return listing
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

async function createShopifyProduct({
    aiResult,
    product_type,
    title,
    vendor,
    sku,
    storeInfo,
    pool,
    productOptions = null,
}) {
    const media =
        aiResult.Media?.map((m) => ({
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
    // Fall back to AI-provided manuals
    if (manuals.length === 0) {
        manuals =
            aiResult.Manuals?.map((manual) => {
                const [name] = manual.split(':')
                const url = manual.replace(`${name}:`, '') || null
                return { name, url }
            }) || []
    }

    for (const manual of manuals) {
        if (!manual.url) continue
        const fileResult = await uploadProductFile(storeInfo, manual.url).catch((err) => {
            console.error(`Failed to upload manual: ${err.message}`)
        })
        if (!fileResult || fileResult.length === 0) {
            console.error(`Failed to upload manual ${manual.name} for product ${title}`)
            continue
        }
        let fileUrl
        let retryCount = 0
        const maxRetries = 3
        while (!fileUrl && retryCount < maxRetries) {
            try {
                fileUrl = await getFileUrl(storeInfo, fileResult[0].id)
            } catch (err) {
                console.error(
                    `Attempt ${retryCount + 1} - Failed to get file URL for manual ${manual.name}:`,
                    err.message
                )
                retryCount++
                await new Promise((resolve) => setTimeout(resolve, 2000))
            }
        }
        if (fileUrl) {
            manual.url = fileUrl
        } else {
            delete manual.url
        }
    }

    const uploadedManuals = manuals.filter((m) => m.url).map((m) => `${m.name}:${m.url}`)

    const needsReview = (aiResult.Features || []).join('').length < 750 || uploadedManuals.length === 0 || !media.length

    const tags = [
        needsReview ? 'Needs Review' : null,
        (aiResult.Features || []).join('').length < 750 ? 'Review: Features' : null,
        uploadedManuals.length === 0 ? 'Review: Manuals' : null,
        !media.length ? 'Review: Images' : null,
    ]

    const product = {
        title: title || aiResult.Title,
        descriptionHtml: aiResult.Description,
        productType: product_type,
        vendor,
        status: !media.length ? 'DRAFT' : 'ACTIVE',
        seo: { description: aiResult.MetaDescription },
        tags: ['new', 'AI Lister', ...tags.filter(Boolean)],
        productOptions: productOptions || undefined,
        metafields: [
            {
                namespace: 'custom',
                key: 'warranty',
                value: (aiResult.Warranty || '').replace(/[\n\r]+/g, ' ').trim(),
                type: 'single_line_text_field',
            },
            {
                namespace: 'custom',
                key: 'manuals',
                value: JSON.stringify(uploadedManuals.map((v) => v.replace(/[\n\r]+/g, ' ').trim())),
                type: 'list.single_line_text_field',
            },
            {
                namespace: 'custom',
                key: 'checkmarks',
                value: JSON.stringify(aiResult.Checkmarks.map((v) => v.replace(/[\n\r]+/g, ' ').trim())),
                type: 'list.single_line_text_field',
            },
            {
                namespace: 'custom',
                key: 'specifications',
                value: JSON.stringify(aiResult.Specifications.map((v) => v.replace(/[\n\r]+/g, ' ').trim())),
                type: 'list.single_line_text_field',
            },
            ...(aiResult.PackageContents?.length
                ? [
                      {
                          namespace: 'custom',
                          key: 'package_contents',
                          value: JSON.stringify(aiResult.PackageContents.map((v) => v.replace(/[\n\r]+/g, ' ').trim())),
                          type: 'list.single_line_text_field',
                      },
                  ]
                : []),
            {
                namespace: 'custom',
                key: 'features',
                value: JSON.stringify(aiResult.Features.map((v) => v.replace(/[\n\r]+/g, ' ').trim())),
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
                    variants(first: 100) {
                        nodes { id selectedOptions { name value } }
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
    { productGid, variantGid, price, compareAtPrice, unit_cost, sku, barcode, tracked = false, metafields = [] },
    storeInfo
) {
    const normalizedMetafields = metafields
        .filter((mf) => mf.value !== undefined && mf.value !== null)
        .map((mf) => ({
            ...mf,
            value: typeof mf.value === 'string' ? mf.value : String(mf.value),
        }))
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
            variants: [
                {
                    id: variantGid,
                    price,
                    ...(compareAtPrice ? { compareAtPrice } : {}),
                    barcode,
                    taxable: true,
                    inventoryItem: { cost: unit_cost, sku, tracked },
                    metafields: normalizedMetafields,
                },
            ],
        }
    )
    if (res.errors) throw new Error(`GraphQL errors: ${JSON.stringify(res.errors)}`)
    if (res.data.productVariantsBulkUpdate.userErrors.length > 0)
        throw new Error(`GraphQL user errors: ${JSON.stringify(res.data.productVariantsBulkUpdate.userErrors)}`)
    return res.data.productVariantsBulkUpdate
}

async function productVariantsBulkCreate(
    { productId, variants, strategy = 'REMOVE_STANDALONE_VARIANT', media = [] },
    storeInfo
) {
    const res = await shopifyGraphQL(
        storeInfo,
        `
        mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy, $media: [CreateMediaInput!]) {
            productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy, media: $media) {
                productVariants {
                    id
                    title
                    selectedOptions { name value }
                }
                userErrors { field message }
            }
        }
        `,
        { productId, variants, strategy, media }
    )
    if (res.errors) throw new Error(`GraphQL errors: ${JSON.stringify(res.errors)}`)
    if (res.data.productVariantsBulkCreate.userErrors.length > 0)
        throw new Error(`GraphQL user errors: ${JSON.stringify(res.data.productVariantsBulkCreate.userErrors)}`)
    return res.data.productVariantsBulkCreate.productVariants
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
            input: `I am generating filters for a collection page by product type.
                I will give you a json objects that has rows of products with id, title, specs, and features.
                I will also give you a list of filter groups.
                Use the specs, title, and features to find the filter values for each filter group.
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

// ── Per-parent listing ──────────────────────────────────────────────────────
async function listOneParent({
    parentId,
    parentEntry,
    skuToProductType,
    listedSkuSet,
    listedItemNoSet,
    storeInfo,
    publications,
    additionalPrompt,
    brandDefaults,
    pool,
}) {
    // 1. Fetch parent product data from S3
    const parentData = await fetchProductFromS3(parentId)
    if (!parentData) {
        console.log(`[parent:${parentId}] No S3 data found, skipping`)
        return null
    }

    const parentSku = parentData.item_no || parentData.sku
    const options = parentEntry.options || []

    // 2. Determine product type — try parentId directly (numeric entity ID), then parentSku, then each option SKU/product_id
    let productType = skuToProductType.get(String(parentId)) || skuToProductType.get(parentSku)
    if (!productType) {
        for (const opt of options) {
            productType = skuToProductType.get(String(opt.product_id)) || skuToProductType.get(opt.sku)
            if (productType) break
        }
    }
    if (!productType) {
        console.log(`[parent:${parentId}] No product type mapping for ${parentSku || parentId}, skipping`)
        return null
    }
    if (PRODUCT_TYPE_FILTER && productType !== PRODUCT_TYPE_FILTER) {
        console.log(`[parent:${parentId}] Skipping type "${productType}" (filter: "${PRODUCT_TYPE_FILTER}")`)
        return null
    }

    // 3. Skip if already listed
    if (listedSkuSet.has(parentSku) || listedItemNoSet.has(parentSku) || listedItemNoSet.has(String(parentId))) {
        console.log(`[${parentSku}] Already listed, skipping`)
        return null
    }
    if (options.some((o) => o.sku && listedSkuSet.has(o.sku))) {
        console.log(`[${parentSku}] Variant already listed, skipping`)
        return null
    }

    const isConfigurable = options.length > 1

    if (!isConfigurable) {
        return
    }

    // 4. Parse option groups for configurable products
    let productOptions = null
    let parsedOptions = [] // [{name, value, opt}]

    if (isConfigurable) {
        productOptions = parseProductOptions(options)
        parsedOptions = parseVariantOptions(options)
    }

    // 5. Pricing — first option or parent data
    const firstOpt = options[0] || {}
    const specialPrice =
        parseFloat(firstOpt.special_price) ||
        parseFloat(parentData.price?.special_price) ||
        parseFloat(parentData.price?.final_price) ||
        0
    const oldSpecialPrice = parseFloat(firstOpt.old_special_price) || parseFloat(parentData.price?.price) || 0
    const cost = parseFloat((specialPrice * COSTWAY_DISCOUNT).toFixed(2))
    const price = parseFloat((specialPrice > 0 ? specialPrice - 1 : 0).toFixed(2))
    const compareAtPrice =
        oldSpecialPrice && oldSpecialPrice > specialPrice ? parseFloat((oldSpecialPrice - 1).toFixed(2)) : null

    const productUrl = parentData.url_path
        ? `https://www.costway.com/${parentData.url_path}`
        : `https://www.costway.com/api/product/${parentId}`

    console.log(`[${parentSku}] Starting... (parent: ${parentId}, ${options.length} variant(s), type: ${productType})`)

    // 6. Generate AI listing from parent data
    const aiResult = await generateListingObject({
        s3Data: parentData,
        productType,
        additional_prompt: additionalPrompt,
    })
    console.log(`[${parentSku}] AI Title: ${aiResult.Title}`)

    // 7. Apply brand defaults
    if (brandDefaults) {
        if (brandDefaults.checkmarks?.length) aiResult.Checkmarks = brandDefaults.checkmarks
        if (brandDefaults.warranty?.length) aiResult.Warranty = brandDefaults.warranty
        if (brandDefaults.manuals?.length) aiResult.Manuals = brandDefaults.manuals
    }

    // 8. Upload all gallery images to S3 (first image gets background removed)
    const originalImageCount = aiResult.Media?.length || 0
    if (originalImageCount > 0) {
        console.log(`[${parentSku}] Uploading ${originalImageCount} image(s) to S3...`)
        const uploadedMedia = []
        for (let i = 0; i < originalImageCount; i++) {
            const item = aiResult.Media[i]
            try {
                let s3Url
                if (i === 0) {
                    const s3PreliminaryUrl = await uploadGalleryImage(item.originalSource, STORE_ID).catch((err) => {
                        console.error(`[${parentSku}] Failed to upload image ${i}: ${err.message}`)
                        return null
                    })
                    s3Url = await removeFirstImageBackground([s3PreliminaryUrl], STORE_ID).catch((err) => {
                        console.error(`[${parentSku}] BG removal failed for image 0: ${err.message}`)
                        return null
                    })
                } else {
                    s3Url = await uploadGalleryImage(item.originalSource, STORE_ID).catch((err) => {
                        console.error(`[${parentSku}] Failed to upload image ${i}: ${err.message}`)
                        return null
                    })
                }
                if (s3Url) uploadedMedia.push({ ...item, originalSource: s3Url })
            } catch (err) {
                console.error(`[${parentSku}] Unexpected error processing image ${i}: ${err.message}`)
            }
        }
        aiResult.Media = uploadedMedia
        console.log(`[${parentSku}] ✓ ${uploadedMedia.length}/${originalImageCount} image(s) uploaded to S3`)
    }

    // 9. Create Shopify product (with productOptions for configurable)
    const createResponse = await createShopifyProduct({
        aiResult,
        product_type: productType,
        vendor: 'Costway',
        sku: parentSku,
        storeInfo,
        pool,
        productOptions,
    })

    if (createResponse.data?.productCreate?.userErrors?.length > 0) {
        console.error(`[${parentSku}] Shopify errors:`, createResponse.data.productCreate.userErrors)
        throw new Error('Shopify product creation failed')
    }

    const createdProduct = createResponse.data?.productCreate?.product
    if (!createdProduct) {
        console.error(`[${parentSku}] No product returned:`, JSON.stringify(createResponse))
        throw new Error('No product returned from Shopify')
    }

    console.log(`[${parentSku}] ✓ Created: ${createdProduct.title} (${createdProduct.id})`)

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
            'Costway',
            'draft',
            STORE_ID,
            JSON.stringify(aiResult.Specifications || []),
            JSON.stringify(aiResult.Features || []),
        ]
    ).catch((err) => console.error(`[${parentSku}] Failed to insert stripped product row:`, err.message))

    // Publish to sales channels
    if (publications.length > 0) {
        await publishProduct(createdProduct.id, publications, storeInfo).catch((err) =>
            console.error(`[${parentSku}] Failed to publish:`, err.message)
        )
        console.log(`[${parentSku}] ✓ Published to ${publications.length} sales channel(s)`)
    }

    // 10. Variant setup
    if (!isConfigurable) {
        // Simple product — update the single auto-created variant
        const variantGid = createdProduct.variants?.nodes?.[0]?.id
        if (variantGid) {
            const itemNo = firstOpt.sku || parentSku
            await updateVariant(
                {
                    productGid: createdProduct.id,
                    variantGid,
                    price: String(price),
                    compareAtPrice: compareAtPrice ? String(compareAtPrice) : null,
                    unit_cost: String(cost),
                    sku: itemNo,
                    barcode: '',
                    tracked: true,
                    metafields: [
                        { namespace: 'custom', key: 'supplier_sku', value: itemNo, type: 'single_line_text_field' },
                        {
                            namespace: 'custom',
                            key: 'part_number',
                            value: parentData.item_no,
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
                        {
                            namespace: 'custom',
                            key: 'weblinks',
                            value: JSON.stringify([{ link: productUrl, title: 'Manufacturer Website' }]),
                            type: 'json',
                        },
                    ],
                },
                storeInfo
            )
            console.log(`[${parentSku}] ✓ Variant updated (${itemNo})`)
        }
    } else {
        // Configurable — bulk-create all variants, removing the default stub
        const variantInputs = []
        const media = []
        for (const { name, value, opt } of parsedOptions) {
            const optionJson = await fetchProductFromS3(opt.product_id)
            const optSpecial = parseFloat(opt.special_price) || specialPrice
            const optOld = parseFloat(opt.old_special_price) || oldSpecialPrice
            const optCost = parseFloat((optSpecial * COSTWAY_DISCOUNT).toFixed(2))
            const optPrice = parseFloat((optSpecial > 0 ? optSpecial - 1 : 0).toFixed(2))
            const optCompare = optOld && optOld > optSpecial ? parseFloat((optOld - 1).toFixed(2)) : null
            const itemNo = opt.sku || parentSku
            let mediaSrc
            if (optionJson?.gallery?.[0]?.original_image) {
                const s3Url = await uploadGalleryImage(optionJson?.gallery?.[0]?.original_image, STORE_ID).catch(
                    (err) => {
                        console.error(`[${parentSku}] Failed to upload image: ${err.message}`)
                        return null
                    }
                )
                media.push({
                    alt: optionJson?.gallery?.[0]?.alt,
                    mediaContentType: 'IMAGE',
                    originalSource: s3Url,
                })
                mediaSrc = s3Url
            }

            variantInputs.push({
                mediaSrc,
                price: String(optPrice),
                ...(optCompare ? { compareAtPrice: String(optCompare) } : {}),
                barcode: '',
                taxable: true,
                inventoryItem: { sku: itemNo, cost: String(optCost), tracked: true },
                optionValues: [{ optionName: name, name: value }],
                metafields: [
                    { namespace: 'custom', key: 'supplier_sku', value: itemNo, type: 'single_line_text_field' },
                    {
                        namespace: 'custom',
                        key: 'part_number',
                        value: parentData.item_no,
                        type: 'single_line_text_field',
                    },
                    {
                        namespace: 'custom',
                        key: 'projected_unit_cost',
                        value: String(optCost),
                        type: 'single_line_text_field',
                    },
                    {
                        namespace: 'custom',
                        key: 'projected_price',
                        value: String(optPrice),
                        type: 'single_line_text_field',
                    },
                    {
                        namespace: 'custom',
                        key: 'weblinks',
                        value: JSON.stringify([{ link: productUrl, title: 'Manufacturer Website' }]),
                        type: 'json',
                    },
                ],
            })
        }

        const createdVariants = await productVariantsBulkCreate(
            {
                productId: createdProduct.id,
                variants: variantInputs,
                strategy: 'REMOVE_STANDALONE_VARIANT',
                media: media.length > 0 ? media : undefined,
            },
            storeInfo
        )
        console.log(`[${parentSku}] ✓ Created ${createdVariants.length} variant(s)`)
    }

    // Record listing event
    await createListingEvent(pool, {
        product_id: numericProductId,
        event_type: 'PRODUCT_LISTED',
        event_data: JSON.stringify({
            source: 'AI_LISTER_SCRIPT_V2',
            sku: parentSku,
            item_no: parentSku,
            product_type: productType,
            price: String(price),
            unit_cost: String(cost),
            parent_id: parentId,
            variant_count: options.length,
        }),
        store_id: STORE_ID,
    }).catch((err) => console.error(`[${parentSku}] Failed to create listing event:`, err.message))

    // Generate AI filters
    await generateFiltersForNewProduct({
        pool,
        productId: numericProductId,
        productType,
        productData: {
            title: createdProduct.title,
            specifications: aiResult.Specifications,
            features: aiResult.Features,
        },
    })
        .then((result) => {
            if (result) console.log(`[${parentSku}] ✓ Generated ${result.length} filter values`)
        })
        .catch((err) => console.error(`[${parentSku}] Failed to generate filters:`, err.message))

    return { sku: parentSku, productId: createdProduct.id }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const pool = createPool()

    try {
        // 1. Load SKU → product type mapping
        console.log('Loading Costway SKU type mapping...')
        const mappingPath = new URL('./costway_sku_type_mapping.csv', import.meta.url)
        if (!fs.existsSync(mappingPath)) {
            throw new Error('Missing costway_sku_type_mapping.csv. Run generateCostwayDistinctTypes.js first.')
        }
        const mappingCsv = fs.readFileSync(mappingPath, 'utf-8')
        const mappingRows = parse(mappingCsv, {
            columns: true,
            skip_empty_lines: true,
            relax_column_count: true,
        })
        const skuToProductType = new Map()
        for (const row of mappingRows) {
            const mappedType = row['Mapped Product Type']?.trim()
            const sku = row['SKU']?.trim()
            if (mappedType && sku) skuToProductType.set(sku, mappedType)
        }
        console.log(
            `Found ${skuToProductType.size} SKUs mapped${PRODUCT_TYPE_FILTER ? ` (filtering to "${PRODUCT_TYPE_FILTER}")` : ' (all types)'}`
        )
        if (skuToProductType.size === 0) {
            console.log('No SKUs found. Exiting.')
            return
        }

        // 2. Load listed SKUs and item_nos from DB
        console.log('Loading listed Costway SKUs from database...')
        const listedSkuRows = await query(
            pool,
            `SELECT vn.sku FROM variants_new vn JOIN products p ON p.id = vn.product_id WHERE p.vendor = 'Costway' AND vn.sku IS NOT NULL`
        )
        const listedSkuSet = new Set(listedSkuRows.map((r) => r.sku))
        const listedEventRows = await query(
            pool,
            `SELECT JSON_UNQUOTE(JSON_EXTRACT(event_data, '$.item_no')) as item_no FROM product_listing_events WHERE store_id = ? AND event_type = 'PRODUCT_LISTED' AND JSON_EXTRACT(event_data, '$.item_no') IS NOT NULL`,
            [STORE_ID]
        ).catch(() => [])
        const listedItemNoSet = new Set(listedEventRows.map((r) => r.item_no).filter(Boolean))
        console.log(`${listedSkuSet.size} SKUs and ${listedItemNoSet.size} item_nos already listed`)

        // 3. Get store info
        const storeInfo = await getStoreInfo(pool)
        console.log(`Using store: ${storeInfo.shopify_name}`)

        // 4. Get brand-specific AI lister prompt
        let additionalPrompt = null
        try {
            const promptRows = await getAiListerPrompt(pool, 'Costway')
            if (promptRows.length > 0 && promptRows[0].prompt) {
                additionalPrompt = promptRows[0].prompt
                console.log('Loaded Costway AI lister brand prompt')
            }
        } catch (err) {
            console.warn('Could not load AI lister brand prompt:', err.message)
        }

        // 5. Get brand-level product setup defaults
        let brandDefaults = null
        try {
            const [defaults] = await getProductSetupDefaults(pool, 'Costway')
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
                console.log('Loaded Costway brand defaults (checkmarks, warranty, manuals)')
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

        // 7. Iterate S3 configurable parent batches
        let batchIndex = 0
        let totalListed = 0
        let totalFailed = 0
        let batchesWithNoProgress = 0
        const MAX_BATCHES_NO_PROGRESS = 50

        console.log(`\nListing up to ${LIMIT} product(s) with concurrency ${CONCURRENCY}...\n`)

        while (totalListed < LIMIT) {
            const batchKey = `${S3_PARENTS_PREFIX}/${batchIndex * 100}`
            const batch = await getS3Json(batchKey)

            if (!batch) {
                console.log(`No more parent batches found at index ${batchIndex} (${batchKey}). Done.`)
                break
            }

            const parentIds = Object.keys(batch)
            console.log(`Batch ${batchIndex} (${batchKey}): ${parentIds.length} parent(s)`)
            batchIndex++

            // Filter to parents not yet listed
            const candidates = parentIds.filter((id) => {
                if (listedItemNoSet.has(String(id))) return false
                const opts = batch[id].options || []
                if (opts.some((o) => o.sku && listedSkuSet.has(o.sku))) return false
                return true
            })

            if (candidates.length === 0) {
                console.log('  All parents in this batch already listed, skipping...')
                batchesWithNoProgress++
                if (batchesWithNoProgress >= MAX_BATCHES_NO_PROGRESS) {
                    console.log(`No progress after ${MAX_BATCHES_NO_PROGRESS} consecutive batches. Done.`)
                    break
                }
                continue
            }

            const toList = candidates
            console.log(`  ${toList.length} candidate(s) to attempt this batch`)

            const listedBefore = totalListed

            for (let i = 0; i < toList.length; i += CONCURRENCY) {
                const chunk = toList.slice(i, i + CONCURRENCY)
                const chunkNum = Math.floor(i / CONCURRENCY) + 1
                const totalChunks = Math.ceil(toList.length / CONCURRENCY)
                console.log(`\n── Chunk ${chunkNum}/${totalChunks} (${chunk.length} products) ──\n`)

                const results = await Promise.allSettled(
                    chunk.map((parentId) =>
                        listOneParent({
                            parentId,
                            parentEntry: batch[parentId],
                            skuToProductType,
                            listedSkuSet,
                            listedItemNoSet,
                            storeInfo,
                            publications,
                            additionalPrompt,
                            brandDefaults,
                            pool,
                        })
                    )
                )
                for (const r of results) {
                    if (r.status === 'fulfilled' && r.value) {
                        totalListed++
                        batchesWithNoProgress = 0
                    } else if (r.status === 'rejected') {
                        totalFailed++
                        console.error('Product failed:', r.reason?.message || r.reason)
                    }
                }
            }

            if (totalListed === listedBefore) {
                // Nothing was listed from this batch (all skipped)
                batchesWithNoProgress++
                if (batchesWithNoProgress >= MAX_BATCHES_NO_PROGRESS) {
                    console.log(`No progress after ${MAX_BATCHES_NO_PROGRESS} consecutive batches. Done.`)
                    break
                }
            }
        }

        console.log(`\n✓ Done! ${totalListed} listed, ${totalFailed} failed.`)
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
function parseProductOptions(relations) {
    const options = []

    for (const relation of relations) {
        for (const key in relation.option) {
            let foundOption = options.find((o) => o.name === key)

            if (!foundOption) {
                foundOption = {
                    name: key,
                    values: [],
                }
                options.push(foundOption)
            }

            const value = relation.option[key].option_value

            if (!foundOption.values.some((v) => v.name === value)) {
                foundOption.values.push({ name: value })
            }
        }
    }

    return options
}

function parseVariantOptions(relations) {
    return relations.map((relation) => {
        const key = Object.keys(relation.option)[0]
        const value = relation.option[key].option_value

        return {
            name: key,
            value,
            opt: relation,
        }
    })
}
