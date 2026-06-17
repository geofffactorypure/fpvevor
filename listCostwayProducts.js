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
        const key = stripHtml(match[1]).trim().replace(/\n/g, ' ')
        const value = stripHtml(match[2]).trim().replace(/\n/g, ' ')
        if (key && value) {
            specs.push(`${key}::${value}`)
        }
    }
    return specs
}

function parseFeatures(keyFeaturesHtml) {
    if (!keyFeaturesHtml) return []
    const features = []
    // Split by <br /> or bullet points
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

// ── Prompts ─────────────────────────────────────────────────────────────────
const titlePrompt = `Generate a product title and package contents for an authorized dealer listing.

Title Rules:
- If SKU is easily recitable (not random numbers/characters): [brand] [sku] [product type] [product title] New
- Otherwise: [brand] [product type] [product title] New
- The product type MUST appear immediately after the brand (or SKU if included) — this takes priority over SEO optimization
- The remaining product title words can be SEO optimized and reordered, but product type placement is non-negotiable
- Truncate units: 'inches' to '"', 'feet' to "'", 'pounds' to 'lbs', etc.

Package Contents Rules:
- List what comes in the box as "Nx Item" entries (e.g. "1x Umbrella Base", "4x Mounting Bolts", "1x User Manual")
- Use singular form for each item
- If you can't determine contents from the product data, return just "1x [product type singular form]"

Return ONLY valid JSON in this format, nothing else:
{"title": "...", "packageContents": ["1x ...", "1x ..."]}

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
    const specifications = parseSpecifications(s3Data.texts?.specifications)

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
        PackageContents: [],
        Checkmarks: checkmarks,
        Specifications: specifications,
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

// ── AI Generation (title only) ──────────────────────────────────────────────
function buildProductDataForAI(s3Data, productType) {
    const data = {
        brand: 'Costway',
        sku: s3Data.sku,
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
    let packageContents = [`1x ${productType}`]
    try {
        const parsed = JSON.parse(titleResponse.output_text.trim())
        title = parsed.title || ''
        if (Array.isArray(parsed.packageContents) && parsed.packageContents.length > 0) {
            packageContents = parsed.packageContents
        }
    } catch {
        // Fallback: treat entire response as title (old behavior)
        title = titleResponse.output_text.trim().replace(/^["']|["']$/g, '')
    }
    console.log(`  AI generated title: ${title}`)

    // Build the full listing object from data (no AI needed for these)
    const listing = buildListingFromData(s3Data, productType, title)
    listing.PackageContents = packageContents

    // Filter small images
    listing.Media = await filterSmallImages(listing.Media)

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

async function createShopifyProduct({ aiResult, product_type, title, vendor, sku, storeInfo, pool }) {
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

    const needsReview =
        !aiResult.PackageContents ||
        aiResult.PackageContents.length === 0 ||
        (aiResult.Features || []).join('').length < 750 ||
        uploadedManuals.length === 0 ||
        !media.length

    const tags = [
        needsReview ? 'Needs Review' : null,
        !aiResult.PackageContents || aiResult.PackageContents.length === 0 ? 'Review: Package Contents' : null,
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
        metafields: [
            {
                namespace: 'custom',
                key: 'warranty',
                value: aiResult.Warranty,
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
                value: JSON.stringify(aiResult.PackageContents),
                type: 'list.single_line_text_field',
            },
            {
                namespace: 'custom',
                key: 'checkmarks',
                value: JSON.stringify(aiResult.Checkmarks),
                type: 'list.single_line_text_field',
            },
            {
                namespace: 'custom',
                key: 'specifications',
                value: JSON.stringify(aiResult.Specifications),
                type: 'list.single_line_text_field',
            },
            {
                namespace: 'custom',
                key: 'features',
                value: JSON.stringify(aiResult.Features),
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

// ── Feed Parsing ────────────────────────────────────────────────────────────
const FEED_CACHE_FILE = './costway_data/feed_cache.csv'

function parseFeedRows() {
    if (!fs.existsSync(FEED_CACHE_FILE)) {
        throw new Error(`Missing feed cache: ${FEED_CACHE_FILE}. Run scrapeCostwayFeed.js first.`)
    }

    const feedCsv = fs.readFileSync(FEED_CACHE_FILE, 'utf8')
    const lines = feedCsv.split('\n')
    const header = lines[0].split(',')

    // Get column indices
    const itemLinkIdx = header.indexOf('Item Link')
    const itemNoIdx = header.indexOf('Item No')
    const titleIdx = header.indexOf('Title')
    const priceIdx = header.indexOf('Variant Price')
    const comparePriceIdx = header.indexOf('Variant Compare At Price')
    const inStockIdx = header.indexOf('1=In Stock|0=OOS')

    if (itemLinkIdx === -1) throw new Error('Could not find "Item Link" column in feed header')

    const rows = []
    const seen = new Set()

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line) continue

        const fields = line.split(',')
        const fep = extractFep(fields[itemLinkIdx])
        if (!fep || seen.has(fep)) continue
        seen.add(fep)

        const itemNo = (fields[itemNoIdx] || '').trim()
        const title = (fields[titleIdx] || '').trim()
        const price = (fields[priceIdx] || '').trim()
        const comparePrice = (fields[comparePriceIdx] || '').trim()
        const inStock = (fields[inStockIdx] || '').trim()
        const itemLink = (fields[itemLinkIdx] || '').trim()

        rows.push({
            fep,
            itemNo,
            title,
            price: parseFloat(price) || 0,
            comparePrice: parseFloat(comparePrice) || 0,
            inStock: inStock === '1',
            itemLink,
        })
    }

    return rows
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const pool = createPool()

    try {
        // 1. Load the SKU -> product type mapping
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
            if (mappedType && sku && (!PRODUCT_TYPE_FILTER || mappedType === PRODUCT_TYPE_FILTER)) {
                skuToProductType.set(sku, mappedType)
            }
        }
        console.log(
            `Found ${skuToProductType.size} SKUs mapped${PRODUCT_TYPE_FILTER ? ` to "${PRODUCT_TYPE_FILTER}"` : ' (all types)'}`
        )
        if (skuToProductType.size === 0) {
            console.log('No SKUs found. Exiting.')
            return
        }

        // 2. Parse the Costway feed
        console.log('Parsing Costway feed...')
        const feedRows = parseFeedRows()
        console.log(`Feed has ${feedRows.length} unique products`)

        // 3. Filter feed rows to matching SKUs (exclude already-listed)
        console.log('Loading listed Costway SKUs from database...')
        const listedSkuRows = await query(
            pool,
            `SELECT vn.sku FROM variants_new vn JOIN products p ON p.id = vn.product_id WHERE p.vendor = 'Costway' AND vn.sku IS NOT NULL`
        )
        const listedSkuSet = new Set(listedSkuRows.map((r) => r.sku))
        // Also load listed item numbers from listing events to handle sku format change
        const listedEventRows = await query(
            pool,
            `SELECT JSON_UNQUOTE(JSON_EXTRACT(event_data, '$.item_no')) as item_no FROM product_listing_events WHERE store_id = ? AND event_type = 'PRODUCT_LISTED' AND JSON_EXTRACT(event_data, '$.item_no') IS NOT NULL`,
            [STORE_ID]
        ).catch(() => [])
        const listedItemNoSet = new Set(listedEventRows.map((r) => r.item_no).filter(Boolean))

        const matchingProducts = feedRows.filter((row) => {
            return skuToProductType.has(row.itemNo) && !listedSkuSet.has(row.itemNo) && !listedItemNoSet.has(row.itemNo)
        })
        console.log(
            `Found ${matchingProducts.length} unlisted products in feed${PRODUCT_TYPE_FILTER ? ` matching "${PRODUCT_TYPE_FILTER}"` : ''} (${listedSkuSet.size} SKUs excluded as already listed)`
        )
        if (matchingProducts.length === 0) {
            console.log('No matching products found in feed. Exiting.')
            return
        }

        // 4. Get store info
        const storeInfo = await getStoreInfo(pool)
        console.log(`Using store: ${storeInfo.shopify_name}`)

        // 5. Get brand-specific AI lister prompt
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

        // 6. Get brand-level product setup defaults
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

        // 7. Get publications (sales channels)
        const publications = await getPublications(storeInfo).catch((err) => {
            console.error('Failed to retrieve publications:', err.message)
            return []
        })
        console.log(`Found ${publications.length} sales channel(s)`)

        // 8. List products
        const toList = matchingProducts.slice(0, LIMIT)
        console.log(`\nListing ${toList.length} product(s) with concurrency ${CONCURRENCY}...\n`)

        let successCount = 0
        let failCount = 0

        async function listOneProduct(row) {
            const itemNo = row.itemNo
            const fepId = row.fep
            const productUrl = getProductUrl(row.itemLink)
            const productType = skuToProductType.get(itemNo)

            console.log(`[${itemNo}] Starting... (fep: ${fepId})`)

            // Fetch product data from S3
            const s3Data = await fetchProductFromS3(fepId)
            if (!s3Data) {
                throw new Error(`No S3 data found for fep ${fepId}. Run scrapeCostwayFeed.js first.`)
            }

            // Use s3Data.sku as the product SKU (e.g. "OP2263")
            const sku = s3Data.sku || itemNo

            // Pricing from S3 data: special_price determines cost, final_price - $1 = list price, price.price = compare at
            const s3Price = s3Data.price || {}
            const specialPrice = parseFloat(s3Price.special_price) || parseFloat(s3Price.final_price) || row.price
            const finalPrice = parseFloat(s3Price.final_price) || specialPrice
            const regularPrice = parseFloat(s3Price.price) || 0
            const cost = parseFloat((specialPrice * COSTWAY_DISCOUNT).toFixed(2))
            const price = parseFloat((finalPrice - 1).toFixed(2))
            const compareAtPrice =
                regularPrice && regularPrice > finalPrice ? parseFloat((regularPrice - 1).toFixed(2)) : null

            // Generate listing via OpenAI (no web search needed)
            const aiResult = await generateListingObject({
                s3Data,
                productType,
                additional_prompt: additionalPrompt,
            })
            console.log(`[${sku}] AI Title: ${aiResult.Title}`)

            // Apply brand defaults
            if (brandDefaults) {
                if (brandDefaults.checkmarks?.length) aiResult.Checkmarks = brandDefaults.checkmarks
                if (brandDefaults.warranty?.length) aiResult.Warranty = brandDefaults.warranty
                if (brandDefaults.manuals?.length) aiResult.Manuals = brandDefaults.manuals
            }

            // Remove background from first image
            const firstImageUrl = await removeFirstImageBackground(
                aiResult.Media?.map((m) => m.originalSource),
                STORE_ID
            ).catch((err) => {
                console.error(`[${sku}] Failed to remove background: ${err.message}`)
                return null
            })
            if (aiResult.Media?.[0] && firstImageUrl) {
                aiResult.Media[0].originalSource = firstImageUrl
            }

            // Create product on Shopify
            const createResponse = await createShopifyProduct({
                aiResult,
                product_type: productType,
                vendor: 'Costway',
                sku,
                storeInfo,
                pool,
            })

            if (createResponse.data?.productCreate?.userErrors?.length > 0) {
                console.error(`[${sku}] Shopify errors:`, createResponse.data.productCreate.userErrors)
                throw new Error('Shopify product creation failed')
            }

            const createdProduct = createResponse.data?.productCreate?.product
            if (!createdProduct) {
                console.error(`[${sku}] No product returned:`, JSON.stringify(createResponse))
                throw new Error('No product returned from Shopify')
            }

            console.log(`[${sku}] ✓ Created: ${createdProduct.title} (${createdProduct.id})`)

            // Insert stripped product row so FK constraints are satisfied before webhook sync
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
            ).catch((err) => {
                console.error(`[${sku}] Failed to insert stripped product row:`, err.message)
            })

            // Publish to sales channels
            if (publications.length > 0) {
                await publishProduct(createdProduct.id, publications, storeInfo).catch((err) => {
                    console.error(`[${sku}] Failed to publish to sales channels:`, err.message)
                })
                console.log(`[${sku}] ✓ Published to ${publications.length} sales channel(s)`)
            }

            // Update variant with price, cost, SKU, metafields
            const variantGid = createdProduct.variants?.nodes?.[0]?.id
            if (variantGid) {
                await updateVariant(
                    {
                        productGid: createdProduct.id,
                        variantGid,
                        price: String(price),
                        compareAtPrice: compareAtPrice ? String(compareAtPrice) : null,
                        unit_cost: String(cost),
                        sku,
                        barcode: '',
                        tracked: true,
                        metafields: [
                            {
                                namespace: 'custom',
                                key: 'supplier_sku',
                                value: sku,
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
                console.log(`[${sku}] ✓ Variant updated`)
            }

            // Record listing event
            await createListingEvent(pool, {
                product_id: createdProduct.id.split('/').pop(),
                event_type: 'PRODUCT_LISTED',
                event_data: JSON.stringify({
                    source: 'AI_LISTER_SCRIPT',
                    sku,
                    item_no: itemNo,
                    product_type: productType,
                    price: String(price),
                    unit_cost: String(cost),
                    fep_id: fepId,
                }),
                store_id: STORE_ID,
            }).catch((err) => {
                console.error(`[${sku}] Failed to create listing event:`, err.message)
            })

            // Generate AI filters if filter groups exist for this product type
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
                    if (result) console.log(`[${sku}] ✓ Generated ${result.length} filter values`)
                })
                .catch((err) => {
                    console.error(`[${sku}] Failed to generate filters:`, err.message)
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
