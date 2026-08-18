import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import xlsx from 'xlsx'
import fs from 'fs'
import sharp from 'sharp'
import OpenAI from 'openai'
import mysql from 'mysql'
import { parse } from 'csv-parse/sync'
import { S3 as AWSS3 } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { JSDOM, VirtualConsole } from 'jsdom'
import { chromium as patchright } from 'patchright'
import jwt from 'jsonwebtoken'
import { listedVevorSkus } from './listedVevorSkus.js'

// ── Config ──────────────────────────────────────────────────────────────────
const VEVOR_ENDPOINT = process.env.VEVOR_ENDPOINT
const PHOTOROOM_API_KEY = process.env.PHOTOROOM_API_KEY
const FPHOOKS_ENDPOINT = process.env.MODE === 'production' ? 'https://www.fphooks.com' : 'http://localhost:8081'
const VEVOR_DISCOUNT = 0.85
const STORE_ID = 1
const PRODUCT_TYPE_FILTER = process.argv[2] || null
const LIMIT = parseInt(process.argv[3]) || 10
const CONCURRENCY = parseInt(process.argv[4]) || 10
const SHOPIFY_API_VERSION = '2026-01'

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

// ── Prompts ─────────────────────────────────────────────────────────────────
const listingPrompt = `I am listing products as an authorized dealer. We have specific fields that we populate on our site with a specific data structure. Please scan ONLY the following vendor product page for these fields and generate an output with this form 
Output and format: 
- Title - if SKU is easily recitable, like not just random numbers and characters, then: [brand] [sku] [product type] [product title] New - Otherwise: [brand] [product type] [product title] New. The product type MUST appear immediately after the brand (or SKU if included) — this takes priority over SEO optimization. The remaining product title words can be SEO optimized and reordered, but product type placement is non-negotiable. Also do unit truncating like 'inches' to '"', 'feet' to "'", 'pounds' to 'lbs', etc.
- Description - string 
- Warranty - string with this form: This item comes with a [quantity] [unit of time] warranty.
- Manuals - string[] with this form [name]:[url] 
- PackageContents - string[] 
- Checkmarks - string[] with the following form 
    - Brand new 
    - [factory warranty] 
    - Manufacturer direct shipping from [states]
    - Authorized [vendor] dealer 
- Specifications - string[] with this form [spec]::[value] 
- Features - string[] 
- MetaDescription - string with this form: Product Title Replace. Brand new. [quantity] [unit of time] warranty. Authorized dealer. Free shipping, manufacturer direct.
Notes: 
- if theres any ambiguity, like when you add brackets or parenthesis, just make something absolute with your best guess 
- Include the dimensions in the specifications 
- give this as a JSON object and don't include any other content besides this object in the response (no \`\`\`json blocks)
- dont give any context of where this value was found in the result, and definitely no contentReference / code snippets
- make the content human readable, only the keys of the object should be formatted as one word. For example, in the specs if you want to put 'ScaleLength', make it 'Scale Length'
- For the Description, just give an overview of the product and only use a maximum of 5 sentences
- Don't include the brand as a specification.
- Don't pull product specifications from images, only pull product specifications from markup on the site
- If there is a part of the site with a heading that includes "Features", pull the features directly word for word from the bullets there, otherwise you can infer your own features from the content
- We need the urls for the manuals, so check hrefs. If you can't find a url then dont include the manual.
- For warranty, prefer year values over months: for example if the warranty is 12 months, say 1 year instead. Less than a year you can use months.
- Product Title Replace is a literal value - do not replace this
Page: 
- {URL}
`

// OLD AI image prompt — kept for reference in case we switch back
// const imagePrompt = `Give me the product images from this page and output with this following paramters:
// Page:
// - {URL}
// Output and format:
// - { alt: string, mediaContentType: 'IMAGE', originalSource: string }[]
// Notes:
// - try to get all of the main images, up to 10 images; prefer as many as possible up to that limit
// - Prefer high quality images, if theres a srcset get the largest, if you can detect dimensions ignore anything smaller than 100x100 pixels (thumbnails, icons, etc)
// - give this as a JSON array and don't include any other content besides this object in the response (no \`\`\`json blocks)
// - dont give any context of where this value was found in the result, and definitely no contentReference / code snippets`

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

// ── Image Scraping ──────────────────────────────────────────────────────────
async function scrapeProductImages(productUrl) {
    const res = await fetch(productUrl, {
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
        },
        signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`Failed to fetch product page (${res.status}): ${productUrl}`)
    const html = await res.text()
    const virtualConsole = new VirtualConsole()
    const dom = new JSDOM(html, { virtualConsole })
    try {
        const document = dom.window.document
        const media = Array.from(document.querySelectorAll('.DM_LTL-preview-img'))
            .map((el) => {
                const img = el.querySelector('img')
                const src = img?.getAttribute('data-src') || img?.getAttribute('src') || ''
                if (!src || src.startsWith('data:')) return null
                const alt = img?.getAttribute('alt') || ''
                return { alt, mediaContentType: 'IMAGE', originalSource: src }
            })
            .filter(Boolean)
        if (media.length === 0) {
            console.warn(`No images found with .DM_LTL-preview-img selector on ${productUrl}`)
        } else {
            console.log(`Scraped ${media.length} image(s) from ${productUrl}`)
        }
        return media
    } finally {
        dom.window.close()
    }
}

// ── AI Generation ───────────────────────────────────────────────────────────
async function generateListingObject({ product_url, title, additional_prompt }) {
    let finalListingPrompt = listingPrompt.replace('{URL}', product_url)
    if (additional_prompt) {
        finalListingPrompt += `\nAdditional Instructions:\n${additional_prompt}\n`
    }

    // Fetch listing data from AI and scrape images from HTML in parallel
    const [listingResponse, scrapedMedia] = await Promise.all([
        openai.responses.create({
            model: 'gpt-5.4',
            tools: [{ type: 'web_search' }],
            input: finalListingPrompt,
        }),
        getImagesWithPatchwright(product_url),
    ])

    let listingObject = listingResponse.output_text
    while (typeof listingObject === 'string') {
        try {
            listingObject = JSON.parse(listingObject)
        } catch (err) {
            console.error('Failed to parse AI listing response!', listingResponse.output_text)
            throw new Error('Failed to parse AI listing response!')
        }
    }

    listingObject.Media = await filterSmallImages(scrapedMedia)
    listingObject.Title = title || listingObject.Title
    listingObject.MetaDescription = listingObject.MetaDescription.replace('Product Title Replace', listingObject.Title)
    return listingObject
}

// OLD AI-based image generation — kept for reference in case we switch back
// async function generateListingObject({ product_url, title, additional_prompt }) {
//     let finalListingPrompt = listingPrompt.replace('{URL}', product_url)
//     if (additional_prompt) {
//         finalListingPrompt += `\nAdditional Instructions:\n${additional_prompt}\n`
//     }
//     const [listingResponse, mediaResponse] = await Promise.all([
//         openai.responses.create({
//             model: 'gpt-5.4',
//             tools: [{ type: 'web_search' }],
//             input: finalListingPrompt,
//         }),
//         openai.responses.create({
//             model: 'gpt-5.4',
//             tools: [{ type: 'web_search' }],
//             input: imagePrompt.replace('{URL}', product_url),
//         }),
//     ])
//     let listingObject = listingResponse.output_text
//     while (typeof listingObject === 'string') {
//         try {
//             listingObject = JSON.parse(listingObject)
//         } catch (err) {
//             console.error('Failed to parse AI listing response!', listingResponse.output_text)
//             throw new Error('Failed to parse AI listing response!')
//         }
//     }
//     let mediaObject = mediaResponse.output_text
//     while (typeof mediaObject === 'string') {
//         try {
//             mediaObject = JSON.parse(mediaObject)
//         } catch (err) {
//             console.error('Failed to parse AI media response!', mediaResponse.output_text)
//             throw new Error('Failed to parse AI media response!')
//         }
//     }
//     listingObject.Media = await filterSmallImages(mediaObject)
//     listingObject.Title = title || listingObject.Title
//     listingObject.MetaDescription = listingObject.MetaDescription.replace('Product Title Replace', listingObject.Title)
//     return listingObject
// }

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
    // Fall back to AI-scraped manuals
    if (manuals.length === 0) {
        manuals =
            aiResult.Manuals?.map((manual) => {
                const [name] = manual.split(':')
                const url = manual.replace(`${name}:`, '') || null
                return { name, url }
            }) || []
    }

    for (const manual of manuals) {
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
    { productGid, variantGid, price, unit_cost, sku, barcode, tracked = false, metafields = [] },
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
        // 1. Load the SKU -> product type mapping
        console.log('Loading SKU type mapping...')
        const mappingCsv = fs.readFileSync(new URL('./vevor_sku_type_mapping.csv', import.meta.url), 'utf-8')
        const mappingRows = parse(mappingCsv, {
            columns: true,
            skip_empty_lines: true,
            relax_column_count: true,
        })
        const skuToProductType = new Map()
        for (const row of mappingRows) {
            const mappedType = row['Mapped Product Type']?.trim()
            if (mappedType && (!PRODUCT_TYPE_FILTER || mappedType === PRODUCT_TYPE_FILTER)) {
                skuToProductType.set(row.SKU?.trim(), mappedType)
            }
        }
        console.log(
            `Found ${skuToProductType.size} SKUs mapped${PRODUCT_TYPE_FILTER ? ` to "${PRODUCT_TYPE_FILTER}"` : ' (all types)'}`
        )
        if (skuToProductType.size === 0) {
            console.log('No SKUs found. Exiting.')
            return
        }

        // 2. Fetch the Vevor feed
        console.log('Fetching Vevor feed...')
        const res = await fetch(VEVOR_ENDPOINT)
        const buffer = await res.arrayBuffer()
        const workbook = xlsx.read(Buffer.from(buffer))
        const feedRows = xlsx.utils.sheet_to_json(workbook.Sheets.feed)
        console.log(`Feed has ${feedRows.length} total rows`)

        // 3. Filter feed rows to matching SKUs (exclude already-listed)
        // console.log('Loading listed Vevor SKUs from database...')
        // const listedSkuRows = await query(
        //     pool,
        //     `SELECT vn.sku FROM variants_new vn JOIN products p ON p.id = vn.product_id WHERE p.vendor = 'Vevor' AND vn.sku IS NOT NULL`
        // )
        console.log('Loading SKUs from file')
        const listedSkuRows = listedVevorSkus
        const listedSkuSet = new Set(listedSkuRows.map((r) => r.sku))
        const matchingProducts = feedRows.filter((row) => {
            const sku = (row['SKU'] || '').trim()
            return skuToProductType.has(sku) && !listedSkuSet.has(sku)
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
            const promptRows = await getAiListerPrompt(pool, 'Vevor')
            if (promptRows.length > 0 && promptRows[0].prompt) {
                additionalPrompt = promptRows[0].prompt
                console.log('Loaded Vevor AI lister brand prompt')
            }
        } catch (err) {
            console.warn('Could not load AI lister brand prompt:', err.message)
        }

        // 6. Get brand-level product setup defaults
        let brandDefaults = null
        try {
            const [defaults] = await getProductSetupDefaults(pool, 'Vevor')
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
                console.log('Loaded Vevor brand defaults (checkmarks, warranty, manuals)')
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
            const sku = (row['SKU'] || '').trim()
            const productUrl = (row['Product link'] || '').trim()
            const upc = (row['UPC'] || '').trim()
            const priceRaw = (row['Price'] || '').replace(/[^0-9.]/g, '')
            const price = parseFloat(priceRaw)
            const cost = parseFloat((price * VEVOR_DISCOUNT).toFixed(2))
            const productType = skuToProductType.get(sku)

            console.log(`[${sku}] Starting...`)

            // Generate listing via OpenAI
            const aiResult = await generateListingObject({
                product_url: productUrl,
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
                vendor: 'Vevor',
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
                    'Vevor',
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

            // Update variant with price, cost, SKU, UPC, metafields
            const variantGid = createdProduct.variants?.nodes?.[0]?.id
            if (variantGid) {
                await updateVariant(
                    {
                        productGid: createdProduct.id,
                        variantGid,
                        price: String(price),
                        unit_cost: String(cost),
                        sku,
                        barcode: upc,
                        tracked: true,
                        metafields: [
                            {
                                namespace: 'custom',
                                key: 'upc',
                                value: upc,
                                type: 'single_line_text_field',
                            },
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
                    product_type: productType,
                    price: String(price),
                    unit_cost: String(cost),
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

// image getter - Array.from(document.querySelectorAll('.DM_LTL-preview-img')).map(el => el.querySelector('img').src)

async function getImagesWithPatchwright(url) {
    const browser = await patchright.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'commit' })
    await new Promise((r) => setTimeout(r, 1000))

    const images = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.DM_LTL-preview-img img')).map((img) => ({
            alt: img.alt,
            mediaContentType: 'IMAGE',
            originalSource: img.dataset.src || img.src,
        }))
    })
    await browser.close()
    return images.filter((_, i) => i % 2 === 0)
}
