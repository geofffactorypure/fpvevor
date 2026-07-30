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
// argv[2]: brand filter ("Grizzly", "Shop Fox", "South Bend") or blank for all
const BRAND_FILTER = process.argv[2]?.trim() || null
const LIMIT = parseInt(process.argv[3]) || 10
const CONCURRENCY = parseInt(process.argv[4]) || 3
const SHOPIFY_API_VERSION = '2026-01'

const GRIZZLY_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const openai = new OpenAI({ apiKey: process.env.OPENAI_AI_LISTER_API_KEY })
const S3 = new AWSS3({ region: 'us-east-1' })

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

// Normalize CSV brand → Shopify vendor name
// Grizzly / Grizzly PRO / Grizzly Precision → "Grizzly"
// Shop Fox → "Shop Fox"
// South Bend → "South Bend"
function normalizeBrand(brand) {
    if (!brand) return 'Grizzly'
    const b = brand.trim()
    if (b.toLowerCase().startsWith('grizzly')) return 'Grizzly'
    return b
}

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

// ── Grizzly Product Scraper ─────────────────────────────────────────────────

/**
 * Build the full CDN image URL for a Grizzly image filename.
 * Pattern: https://cdn0.grizzly.com/pics/jpeg1000/{first-letter}/{filename}.jpg
 */
function grizzlyImageUrl(filename) {
    const letter = filename[0].toLowerCase()
    return `https://cdn0.grizzly.com/pics/jpeg1000/${letter}/${filename}.jpg`
}

/**
 * Parse the product description, specs, and features from the Grizzly
 * product Copy HTML (which is HTML-entity-encoded in window.product.Copy).
 *
 * Returns { descriptionHtml, specifications, features }
 *   specifications: string[] — raw spec lines (e.g. "Motor: 2 HP, 120V, 15A")
 *   features: string[] — feature bullet points
 *   descriptionHtml: string — Copy HTML with SPECIFICATIONS and FEATURES sections stripped out
 */
function parseCopyHtml(copyHtml) {
    if (!copyHtml) return { descriptionHtml: '', specifications: [], features: [] }

    const dom = new JSDOM(copyHtml)
    const doc = dom.window.document

    const specifications = []
    const features = []

    // Remove h1 entirely (redundant with the product title)
    doc.querySelectorAll('h1').forEach((el) => el.remove())

    // Demote h2/h3 → p so they render as normal body text, not bold headings
    doc.querySelectorAll('h2, h3').forEach((el) => {
        const p = doc.createElement('p')
        p.innerHTML = el.innerHTML
        el.replaceWith(p)
    })

    // Strip all links — keep link text, remove the anchor (no external grizzly.com refs)
    doc.querySelectorAll('a').forEach((el) => {
        el.replaceWith(doc.createTextNode(el.textContent || ''))
    })

    // Strip boilerplate sentences that add no product value
    const BOILERPLATE = [
        /customer service and technical support teams? are u\.s\.-based/i,
        /u\.s\.-based customer service/i,
        /need help\?/i,
        /written by our u\.s\.-based documentation department/i,
        /made in an iso 9001 factory/i,
        /like all .+products.+warranty/i,
        /parts and accessories for .+products are available/i,
    ]
    doc.querySelectorAll('p').forEach((el) => {
        const text = el.textContent?.trim() || ''
        if (BOILERPLATE.some((re) => re.test(text))) el.remove()
    })

    // Find SPECIFICATIONS and FEATURES list headings, extract items, then remove from DOM
    const headings = Array.from(doc.querySelectorAll('h4'))
    for (const h of headings) {
        const text = h.textContent?.toUpperCase().replace(/:/g, '').trim()
        const list = h.nextElementSibling
        if (!list || list.tagName !== 'UL') continue

        const items = Array.from(list.querySelectorAll('li'))
            .map((li) => li.textContent?.replace(/\s+/g, ' ').trim())
            .filter(Boolean)

        if (text?.includes('SPECIFICATION')) {
            specifications.push(...items)
            list.remove()
            h.remove()
        } else if (text?.includes('FEATURE')) {
            features.push(...items)
            list.remove()
            h.remove()
        }
    }

    // Return plain text for AI description generation (not raw HTML)
    const copyText = doc.body?.textContent?.replace(/\s+/g, ' ').trim() || ''

    return {
        copyText,
        specifications,
        features,
    }
}

/**
 * Scrape all listing data for a Grizzly product from grizzly.com.
 *
 * Tries /products/x/{sku} first; if that page has no window.product or returns
 * a non-OK status, falls back to /parts/{sku}.  Throws if neither URL yields
 * parseable product data or if the resolved page has no description text.
 *
 * Product data is extracted from the embedded window.product JSON object.
 */
async function fetchProductJson(url) {
    const pageRes = await fetch(url, {
        headers: { 'User-Agent': GRIZZLY_UA },
        signal: AbortSignal.timeout(20000),
        redirect: 'follow',
    })
    if (!pageRes.ok) return null
    const pageHtml = await pageRes.text()
    const canonicalUrl = pageRes.url
    const productMatch = pageHtml.match(/window\.product=(\{[\s\S]*?\});(?:window\.|<\/script>)/)
    if (!productMatch) return null
    try {
        return { product: JSON.parse(productMatch[1]), canonicalUrl }
    } catch {
        return null
    }
}

async function scrapeProductData(sku) {
    const skuLower = sku.toLowerCase()

    let parsed = await fetchProductJson(`https://www.grizzly.com/products/x/${skuLower}`)
    if (!parsed) {
        console.log(`[${sku}] Not found at /products/x/ — trying /parts/`)
        parsed = await fetchProductJson(`https://www.grizzly.com/parts/${skuLower}`)
    }
    if (!parsed) throw new Error(`Could not find product data for SKU: ${sku}`)

    const { product, canonicalUrl } = parsed

    const title = `${product.Brand?.Name || 'Grizzly'} ${product.Sku} - ${product.Name}`.trim()
    const upc = product.Upc?.trim() || ''
    const brandName = product.Brand?.Name || 'Grizzly'
    const category = product.Category?.Name || ''

    // Warranty — BaseWarrantyLength is in years (e.g. 1.0)
    let warranty = null
    if (product.BaseWarrantyLength > 0) {
        const years = product.BaseWarrantyLength
        warranty = `${years} year factory warranty`
    }

    // Images
    const imageFilenames = product.Images || (product.DefaultImage ? [product.DefaultImage] : [])
    const media = imageFilenames.slice(0, 15).map((filename) => ({
        alt: title,
        mediaContentType: 'IMAGE',
        originalSource: grizzlyImageUrl(filename),
    }))

    // Description, specs, features from Copy HTML
    const { copyText, specifications, features } = parseCopyHtml(product.Copy || '')
    if (!copyText) throw new Error(`No description found for SKU: ${sku} — skipping`)

    // Manuals — construct predictable CDN URLs based on Resources flags
    const manuals = []
    const resources = product.Resources || {}
    if (resources.HasManual) {
        manuals.push(`Manual:https://cdn0.grizzly.com/manuals/${skuLower}_m.pdf`)
    }
    if (resources.HasSpecSheet) {
        manuals.push(`Specification Sheet:https://cdn0.grizzly.com/specsheets/${skuLower}_ds.pdf`)
    }

    const warrantyLong = warranty ? `This item comes with a ${warranty}.` : 'This item comes with a factory warranty.'
    const metaDescription = `${title}. Brand new. ${warrantyLong}. Authorized dealer. Free shipping, manufacturer direct.`

    // Checkmarks (will be overridden by brand defaults if available)
    const checkmarks = [
        'Brand new',
        warranty || 'Factory warranty',
        'Manufacturer direct shipping',
        `Authorized ${brandName} dealer`,
    ]

    return {
        Title: title,
        ScrapedTitle: title,
        Description: copyText,
        Warranty: warrantyLong,
        Manuals: manuals,
        PackageContents: [],
        Checkmarks: checkmarks,
        Specifications: specifications,
        Features: features,
        MetaDescription: metaDescription,
        Media: media,
        Barcode: upc,
        BrandName: brandName,
        Category: category,
        ProductUrl: canonicalUrl,
        ShippingWeight: product.Weight || 0,
        ShippingHeight: product.Height || 0,
        ShippingDepth: product.Depth || 0,
        ShippingWidth: product.Width || 0,
        IsFreight: product.IsFreight || false,
    }
}

// ── Title Prompt ─────────────────────────────────────────────────────────────
const titlePrompt = `Generate a product title for an authorized dealer listing.

Title Rules:
- Format: [brand] [model] [product type] [product title] New
- The model number MUST appear immediately after the brand name
- The product type (human-readable, e.g. "Benchtop Planer" not "Planers") MUST appear right after the model number
- The remaining product title words can be SEO optimized and reordered
- Truncate units: 'inches' to 'in', 'feet' to 'ft', 'pounds' to 'lbs', 'horsepower' to 'HP'
- Respond with ONLY raw JSON, no markdown, no code fences: {"title": "..."}

Product Data:
{PRODUCT_DATA}
`

// ── Description Prompt ──────────────────────────────────────────────────────
const descriptionPrompt = `Write a concise product description for an authorized dealer listing on an e-commerce site.

Rules:
- 2 to 4 short paragraphs of plain prose
- Focus on what the product is, what it does, and who it is for
- Do NOT mention warranty, customer service, replacement parts, documentation, or brand support
- Do NOT use the brand name in every sentence
- Do NOT use bullet points or headings
- Return ONLY valid HTML using only <p> tags — no other HTML elements, no inline styles, no links

Product Data:
{PRODUCT_DATA}
`

async function generateDescription({ title, copyText, specifications, features }) {
    const productData = JSON.stringify(
        {
            product_title: title,
            raw_copy: copyText.slice(0, 2000),
            specifications: specifications.slice(0, 20),
            features: features.slice(0, 20),
        },
        null,
        2
    )
    const prompt = descriptionPrompt.replace('{PRODUCT_DATA}', productData)
    const response = await openai.responses.create({ model: 'gpt-5.4', input: prompt })
    return response.output_text.trim()
}

async function generateTitle({ scrapedTitle, modelNumber, productType, vendor }) {
    const productData = JSON.stringify(
        { brand: vendor, model: modelNumber, product_type: productType, scraped_title: scrapedTitle },
        null,
        2
    )
    const prompt = titlePrompt.replace('{PRODUCT_DATA}', productData)
    const response = await openai.responses.create({ model: 'gpt-5.4', input: prompt })
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
    // Ensure model number is present after brand if missing
    if (modelNumber && !title.includes(modelNumber)) {
        title = title.replace(new RegExp(`^${vendor}\\s*`, 'i'), `${vendor} ${modelNumber} `)
    }
    // Normalize units with symbols
    title = title.replace(/(\d+\.?\d*)\s*-?\s*(?:inch(?:es)?|in\.?)\b/gi, '$1"')
    title = title.replace(/(\d+\.?\d*)\s*-?\s*(?:feet|foot|ft\.?)\b/gi, "$1'")
    return title
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

function sanitizeSingleLine(val) {
    if (typeof val !== 'string') return val
    return val.replace(/[\r\n\t]+/g, ' ').trim()
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
        (scrapedResult.Features || []).join('').length < 50 ||
        uploadedManuals.length === 0 ||
        !media.length

    const tags = [
        needsReview ? 'Needs Review' : null,
        !scrapedResult.PackageContents || scrapedResult.PackageContents.length === 0
            ? 'Review: Package Contents'
            : null,
        (scrapedResult.Features || []).join('').length < 50 ? 'Review: Features' : null,
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
        tags: ['new', 'Grizzly Lister', ...tags.filter(Boolean)],
        metafields: [
            {
                namespace: 'custom',
                key: 'warranty',
                value: sanitizeSingleLine(scrapedResult.Warranty),
                type: 'single_line_text_field',
            },
            {
                namespace: 'custom',
                key: 'manuals',
                value: JSON.stringify(uploadedManuals.map(sanitizeSingleLine)),
                type: 'list.single_line_text_field',
            },
            {
                namespace: 'custom',
                key: 'package_contents',
                value: JSON.stringify((scrapedResult.PackageContents || []).map(sanitizeSingleLine)),
                type: 'list.single_line_text_field',
            },
            {
                namespace: 'custom',
                key: 'checkmarks',
                value: JSON.stringify(scrapedResult.Checkmarks.map(sanitizeSingleLine)),
                type: 'list.single_line_text_field',
            },
            {
                namespace: 'custom',
                key: 'specifications',
                value: JSON.stringify(scrapedResult.Specifications.map(sanitizeSingleLine)),
                type: 'list.single_line_text_field',
            },
            {
                namespace: 'custom',
                key: 'features',
                value: JSON.stringify(scrapedResult.Features.map(sanitizeSingleLine)),
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
                        nodes { id inventoryItem { id } }
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
    const variantInput = {
        id: variantGid,
        price,
        barcode,
        taxable: true,
        inventoryItem: { cost: unit_cost, sku, tracked },
        metafields: normalizedMetafields,
    }
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

const DEFAULT_LOCATION_INVENTORY_ID = 'gid://shopify/Location/649429017'

async function setInventoryQuantity({ storeInfo, inventoryItemId, locationId, quantity }) {
    const data = await shopifyGraphQL(
        storeInfo,
        `mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) {
                inventoryAdjustmentGroup { id }
                userErrors { field message }
            }
        }`,
        {
            input: {
                name: 'available',
                reason: 'correction',
                ignoreCompareQuantity: true,
                quantities: [{ inventoryItemId, locationId, quantity }],
            },
        }
    )
    const errors = data.inventorySetQuantities?.userErrors
    if (errors?.length > 0) throw new Error(`Inventory set errors: ${JSON.stringify(errors)}`)
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

    // Shipping chart lookup: when Dealer Shipping Cost is "See Chart",
    // look up the flat fee based on dealer price (order merchandise total)
    function lookupShippingCost(dealerPrice) {
        if (dealerPrice >= 150) return 0
        if (dealerPrice >= 100) return 21.99
        if (dealerPrice >= 50) return 18.99
        if (dealerPrice >= 15) return 16.99
        return 8.99
    }

    try {
        // 1. Load griz_price_list.csv (row 1 is metadata; row 2 is headers)
        console.log('Loading griz_price_list.csv...')
        const csvPath = new URL('./griz_price_list.csv', import.meta.url)
        const csvContent = fs.readFileSync(csvPath, 'utf-8')
        const csvRows = parse(csvContent, {
            columns: true,
            skip_empty_lines: true,
            relax_column_count: true,
            relax_quotes: true,
            bom: true,
            from_line: 2,
        })

        // 2. Load grizzly_sku_type_mapping.csv if available
        const skuTypeMappingPath = new URL('./grizzly_sku_type_mapping.csv', import.meta.url)
        const skuTypeMap = new Map()
        if (fs.existsSync(skuTypeMappingPath)) {
            const typeMappingRows = parse(fs.readFileSync(skuTypeMappingPath, 'utf-8'), {
                columns: true,
                skip_empty_lines: true,
                relax_column_count: true,
            })
            for (const r of typeMappingRows) {
                const s = (r['SKU'] || r['Item Number'])?.trim()
                const t = r['Mapped Product Type']?.trim()
                if (s && t) skuTypeMap.set(s, t)
            }
            console.log(`Loaded ${skuTypeMap.size} SKU→type mappings from grizzly_sku_type_mapping.csv`)
        } else {
            console.warn(
                'grizzly_sku_type_mapping.csv not found — products will be listed without a product type unless Category is used as fallback'
            )
        }

        // 3. Filter and transform CSV rows
        const MIN_MARGIN = 0.07
        const allRows = csvRows
            .map((row) => {
                const sku = row['Item Number']?.trim()
                const csvBrand = row['Brand']?.trim()
                const vendor = normalizeBrand(csvBrand)

                const msrp = parseFloat((row['MSRP'] || '').replace(/[^0-9.]/g, '')) || 0
                const dealerMap = parseFloat((row['Dealer MAP'] || '').replace(/[^0-9.]/g, '')) || 0
                const dealerPrice = parseFloat((row['Dealer Price'] || '').replace(/[^0-9.]/g, '')) || 0
                const rawShipping = (row['Dealer Shipping Cost'] || '').trim()
                const shippingCost =
                    rawShipping.toLowerCase() === 'see chart'
                        ? lookupShippingCost(dealerPrice)
                        : parseFloat(rawShipping.replace(/[^0-9.]/g, '')) || 0

                // Pricing rules:
                //   - MAP present AND clears 10% margin → use MAP
                //   - MAP present but below 10% margin → fall through to MSRP undercut rules
                //   - No MAP (or MAP fell through) → try 5% discount off MSRP if margin >= 15%,
                //     otherwise use full MSRP
                // Hard 10% margin floor — skip the product entirely if even MSRP can't clear it.
                const maxDiscount = Math.min(msrp * 0.05, 10)
                const discounted = Math.round(msrp - maxDiscount) // whole dollar, capped at $10 off
                const discountedMargin = discounted > 0 ? (discounted - dealerPrice - shippingCost) / discounted : 0
                const msrpFallback = discountedMargin >= 0.15 ? discounted : Math.round(msrp)

                let price
                if (dealerMap > 0) {
                    const mapMargin = dealerMap > 0 ? (dealerMap - dealerPrice - shippingCost) / dealerMap : 0
                    price = mapMargin >= MIN_MARGIN ? dealerMap : msrpFallback
                } else {
                    price = msrpFallback
                }

                const margin =
                    price > 0 ? Math.round(((price - dealerPrice - shippingCost) / price) * 10000) / 10000 : 0

                // Product type from mapping CSV; fall back to empty (no type)
                const productType = skuTypeMap.get(sku) || ''

                return {
                    sku,
                    vendor,
                    csvBrand,
                    upc: row['UPC']?.trim() || '',
                    description: row['Description']?.trim() || '',
                    price,
                    cost: dealerPrice,
                    msrp,
                    mapPrice: dealerMap,
                    shippingFee: shippingCost,
                    shipType: row['Ship Type']?.trim() || '',
                    productType,
                    discontinued: row['Discontinued']?.trim().toLowerCase() === 'true',
                    itemStatus: row['Item Status']?.trim(),
                    margin,
                }
            })
            .filter((row) => {
                if (!row.sku) return false
                // Whitelist — only list brands we carry
                const ALLOWED_VENDORS = new Set(['Grizzly', 'Shop Fox', 'South Bend'])
                if (!ALLOWED_VENDORS.has(row.vendor)) return false
                // Skip discontinued items
                if (row.discontinued) return false
                // Apply brand filter if specified
                if (BRAND_FILTER && row.vendor !== BRAND_FILTER) return false
                // Hard 7% margin floor — skip anything that can't clear it
                if (row.margin < MIN_MARGIN) {
                    console.warn(`[${row.sku}] Skipping — margin ${(row.margin * 100).toFixed(1)}% is below 7% floor`)
                    return false
                }
                return true
            })

        console.log(
            `Found ${allRows.length} products in CSV${BRAND_FILTER ? ` for brand "${BRAND_FILTER}"` : ''} (all statuses)`
        )

        if (allRows.length === 0) {
            console.log('No products found. Exiting.')
            return
        }

        // 4. Get store info
        const storeInfo = await getStoreInfo(pool)
        console.log(`Using store: ${storeInfo.shopify_name}`)

        // 5. Get already-listed Grizzly/Shop Fox/South Bend SKUs from DB
        console.log('Loading already-listed SKUs from database...')
        const vendorFilter = BRAND_FILTER ? [BRAND_FILTER] : ['Grizzly', 'Shop Fox', 'South Bend']
        const placeholders = vendorFilter.map(() => '?').join(', ')
        const listedSkuRows = await query(
            pool,
            `SELECT vn.sku FROM variants_new vn
             JOIN products p ON p.id = vn.product_id
             WHERE p.vendor IN (${placeholders}) AND vn.sku IS NOT NULL AND p.store_id = ?`,
            [...vendorFilter, STORE_ID]
        )
        const listedSkuSet = new Set(listedSkuRows.map((r) => r.sku))
        console.log(`${listedSkuSet.size} SKUs already listed`)

        // 6. Filter out already-listed SKUs and those with no product type when mapping exists
        const toProcess = allRows.filter((row) => {
            if (listedSkuSet.has(row.sku)) return false
            // If the mapping file exists but has no type for this SKU, skip
            if (skuTypeMap.size > 0 && !row.productType) {
                console.warn(`[${row.sku}] No product type mapping found — skipping`)
                return false
            }
            return true
        })

        console.log(
            `${toProcess.length} unlisted product(s) to process (${listedSkuSet.size} excluded as already listed)`
        )
        if (toProcess.length === 0) {
            console.log('Nothing to list. Exiting.')
            return
        }

        // 7. Get brand-level product setup defaults per vendor
        const brandDefaultsCache = {}
        for (const vendor of new Set(toProcess.map((r) => r.vendor))) {
            try {
                const [defaults] = await getProductSetupDefaults(pool, vendor)
                if (defaults) {
                    brandDefaultsCache[vendor] = {
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
                    console.log(`Loaded brand defaults for vendor "${vendor}"`)
                }
            } catch (err) {
                console.warn(`Could not load brand defaults for "${vendor}":`, err.message)
            }
        }

        // 8. Get publications (sales channels) and primary location
        const publications = await getPublications(storeInfo).catch((err) => {
            console.error('Failed to retrieve publications:', err.message)
            return []
        })
        console.log(`Found ${publications.length} sales channel(s)`)

        const locationId = DEFAULT_LOCATION_INVENTORY_ID

        // 9. List products
        const toList = toProcess.slice(0, LIMIT)
        console.log(`\nListing ${toList.length} product(s) with concurrency ${CONCURRENCY}...\n`)

        let successCount = 0
        let failCount = 0

        async function listOneProduct(row) {
            const {
                sku,
                vendor,
                price,
                cost,
                msrp,
                mapPrice,
                shippingFee,
                shipType,
                productType,
                upc: csvUpc,
                itemStatus,
            } = row
            const inventoryQty = (itemStatus || '').toLowerCase() === 'available' ? 100 : 0

            console.log(`[${sku}] Starting... (vendor: ${vendor})`)

            // Scrape product data from grizzly.com
            const scrapedResult = await scrapeProductData(sku)

            // CSV UPC takes priority; fall back to scraped UPC
            const upc = csvUpc || scrapedResult.Barcode || ''

            // Product type: from mapping, or fall back to Grizzly category from page
            const resolvedProductType = productType || scrapedResult.Category || ''

            // AI-generate title
            const aiTitle = await generateTitle({
                scrapedTitle: scrapedResult.ScrapedTitle,
                modelNumber: sku,
                productType: resolvedProductType,
                vendor,
            })
            scrapedResult.Title = aiTitle
            scrapedResult.MetaDescription = `${aiTitle}. Brand new. ${scrapedResult.Warranty}. Authorized dealer. Free shipping, manufacturer direct.`

            // AI-generate description
            scrapedResult.Description = await generateDescription({
                title: aiTitle,
                copyText: scrapedResult.Description,
                specifications: scrapedResult.Specifications,
                features: scrapedResult.Features,
            })

            console.log(`[${sku}] Title: "${scrapedResult.Title}"`)
            console.log(
                `[${sku}] Features: ${scrapedResult.Features.length}, Specs: ${scrapedResult.Specifications.length}, Manuals: ${scrapedResult.Manuals.length}`
            )

            // Apply brand defaults if set
            const brandDefaults = brandDefaultsCache[vendor]
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
                console.error(`[${sku}] Failed to remove background: ${err.message}`)
                return null
            })
            if (scrapedResult.Media?.[0] && firstImageUrl) {
                scrapedResult.Media[0].originalSource = firstImageUrl
            }

            // Create product on Shopify
            const createResponse = await createShopifyProduct({
                scrapedResult,
                product_type: resolvedProductType,
                vendor,
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

            // Insert stripped product row for FK constraints
            const numericProductId = parseInt(createdProduct.id.split('/').pop())
            await query(
                pool,
                `INSERT IGNORE INTO products (id, title, product_type, vendor, status, store_id, custom_specifications, custom_features)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    numericProductId,
                    createdProduct.title,
                    resolvedProductType,
                    vendor,
                    'draft',
                    STORE_ID,
                    JSON.stringify(scrapedResult.Specifications || []),
                    JSON.stringify(scrapedResult.Features || []),
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

            // Update variant with price, cost, SKU, UPC, shipping fields
            const variantGid = createdProduct.variants?.nodes?.[0]?.id
            if (variantGid) {
                const shippingWeight = scrapedResult.ShippingWeight || 0
                const shippingHeight = scrapedResult.ShippingHeight || 0
                const shippingDepth = scrapedResult.ShippingDepth || 0
                const shippingWidth = scrapedResult.ShippingWidth || 0

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
                            { namespace: 'custom', key: 'upc', value: upc, type: 'single_line_text_field' },
                            {
                                namespace: 'custom',
                                key: 'supplier_sku',
                                value: sku,
                                type: 'single_line_text_field',
                            },
                            {
                                namespace: 'custom',
                                key: 'supplier_model_number',
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
                                value: JSON.stringify([
                                    { link: scrapedResult.ProductUrl, title: 'Manufacturer Website' },
                                ]),
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
                            shippingHeight
                                ? {
                                      namespace: 'custom',
                                      key: 'shipping_height',
                                      value: String(shippingHeight),
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
                            shippingDepth
                                ? {
                                      namespace: 'custom',
                                      key: 'shipping_length',
                                      value: String(shippingDepth),
                                      type: 'single_line_text_field',
                                  }
                                : null,
                            shipType
                                ? {
                                      namespace: 'custom',
                                      key: 'shipping_method',
                                      value: shipType,
                                      type: 'multi_line_text_field',
                                  }
                                : null,
                        ].filter(Boolean),
                    },
                    storeInfo
                )
                console.log(`[${sku}] ✓ Variant updated (price: $${price}, cost: $${cost}, sku: ${sku})`)

                // Set inventory quantity based on Item Status
                const inventoryItemId = createdProduct.variants?.nodes?.[0]?.inventoryItem?.id
                if (inventoryItemId) {
                    await setInventoryQuantity({ storeInfo, inventoryItemId, locationId, quantity: inventoryQty })
                    console.log(`[${sku}] ✓ Inventory set to ${inventoryQty} (${itemStatus})`)
                } else {
                    console.warn(`[${sku}] No inventoryItemId — skipping inventory set`)
                }
            }

            // Record listing event
            await createListingEvent(pool, {
                product_id: createdProduct.id.split('/').pop(),
                event_type: 'PRODUCT_LISTED',
                event_data: JSON.stringify({
                    source: 'GRIZZLY_LISTER_SCRIPT',
                    sku,
                    product_type: resolvedProductType,
                    vendor,
                    price: String(price),
                    unit_cost: String(cost),
                }),
                store_id: STORE_ID,
            }).catch((err) => {
                console.error(`[${sku}] Failed to create listing event:`, err.message)
            })

            // Generate AI filters
            await generateFiltersForNewProduct({
                pool,
                productId: numericProductId,
                productType: resolvedProductType,
                productData: {
                    title: createdProduct.title,
                    specifications: scrapedResult.Specifications,
                    features: scrapedResult.Features,
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
