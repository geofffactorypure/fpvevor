/**
 * checkUtf8Encoding.js
 *
 * Scans all Shopify products for invalid/double-encoded UTF-8 characters in:
 *   - descriptionHtml, title, seoDescription
 *   - metafields: custom.specifications, custom.features, custom.warranty,
 *                 custom.checkmarks, custom.package_contents, custom.manuals
 *
 * Causes the Google Search Console "Invalid UTF-8 encoding [description]" warning.
 *
 * Usage:
 *   node checkUtf8Encoding.js              # scan all products, print report
 *   node checkUtf8Encoding.js --vendor Grizzly   # limit to one vendor
 *   node checkUtf8Encoding.js --fix        # scan + auto-fix via Shopify API
 *   node checkUtf8Encoding.js --fix --vendor Grizzly
 *
 * Output:
 *   utf8_issues.csv — one row per affected product/field
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import mysql from 'mysql'
import fs from 'fs'

// ── Config ────────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2026-01'
const PAGE_SIZE = 250
const FIX_MODE = process.argv.includes('--fix')
const VENDOR_ARG = (() => {
    const idx = process.argv.indexOf('--vendor')
    return idx !== -1 ? process.argv[idx + 1] : null
})()
const HANDLE_ARG = (() => {
    const idx = process.argv.indexOf('--handle')
    return idx !== -1 ? process.argv[idx + 1] : null
})()
const OUT_FILE = 'utf8_issues.csv'

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

// ── Double-encoding replacement map ──────────────────────────────────────────
// These are the most common UTF-8 bytes misread as Latin-1 in product copy.
// Key = garbled string (Latin-1 misread), Value = correct Unicode character.
const REPLACEMENTS = [
    // En dash U+2013 (0xE2 0x80 0x93 → Win-1252 0x93 = U+201C)
    ['â€“', '–'],
    // Em dash U+2014 (0xE2 0x80 0x94 → Win-1252 0x94 = U+201D)
    ['â€”', '—'],
    // Right single quote / apostrophe U+2019 (0xE2 0x80 0x99)
    ['â€™', '\u2019'],
    // Left double quote U+201C (0xE2 0x80 0x9C)
    ['â€œ', '\u201C'],
    // Right double quote U+201D (0xE2 0x80 0x9D)
    ['â€\u009D', '\u201D'],
    // Bullet U+2022 (0xE2 0x80 0xA2)
    ['â€¢', '\u2022'],
    // Ellipsis U+2026 (0xE2 0x80 0xA6)
    ['â€¦', '\u2026'],
    // Degree sign U+00B0 (0xC2 0xB0)
    ['Â°', '°'],
    // Non-breaking space U+00A0 (0xC2 0xA0)
    ['Â\u00A0', '\u00A0'],
    // Registered trademark U+00AE (0xC2 0xAE)
    ['Â®', '®'],
    // Copyright U+00A9 (0xC2 0xA9)
    ['Â©', '©'],
    // Trademark U+2122 (0xE2 0x84 0xA2)
    ['â„¢', '™'],
    // Fractions
    ['Â¼', '¼'],
    ['Â½', '½'],
    ['Â¾', '¾'],
    // Multiplication sign U+00D7
    ['Ã—', '×'],
    // Common accented Latin chars
    ['Ã©', 'é'],
    ['Ã¨', 'è'],
    ['Ã ', 'à'],
    ['Ã¢', 'â'],
    ['Ã«', 'ë'],
    ['Ã®', 'î'],
    ['Ã¯', 'ï'],
    ['Ã´', 'ô'],
    ['Ã¹', 'ù'],
    ['Ã»', 'û'],
    ['Ã¼', 'ü'],
    ['Ã±', 'ñ'],
    ['Ã§', 'ç'],
    ['Ã¦', 'æ'],
    ['Ã¸', 'ø'],
    ['Ã…', 'Å'],
    ['Ã†', 'Æ'],
    ['Ã‡', 'Ç'],
    ['Ã‰', 'É'],
    ['Ã"', 'Ó'],
    ['Ã–', 'Ö'],
    ['Ãœ', 'Ü'],
]

// General detector: any Â or Ã followed by a Latin-1 continuation byte character
// appearing in the string (catches anything not in the map above)
const DOUBLE_ENC_RE = /[\xC2\xC3][\x80-\xBF]|â€[\x00-\xFF]/u

/**
 * Returns true if the string contains any known or suspected double-encoding.
 */
function hasDoubleEncoding(str) {
    if (!str) return false
    if (DOUBLE_ENC_RE.test(str)) return true
    return REPLACEMENTS.some(([bad]) => str.includes(bad))
}

// En/em dash bad keys for plain-dash substitution in non-description fields
const DASH_BAD_KEYS = new Set(['\u00e2\u20ac\u201c', '\u00e2\u20ac\u201d'])

/**
 * Fix all known double-encoded sequences in a string.
 * Applies replacements longest-first to avoid partial matches.
 * @param {string} str
 * @param {boolean} [plainDash=false] - Replace en/em dashes with '-' instead of Unicode dash
 */
function fixDoubleEncoding(str, plainDash = false) {
    if (!str) return str
    let result = str
    // Sort by length descending so longer patterns match first (e.g. â€" before â€)
    const sorted = [...REPLACEMENTS].sort((a, b) => b[0].length - a[0].length)
    for (const [bad, good] of sorted) {
        const replacement = plainDash && DASH_BAD_KEYS.has(bad) ? '-' : good
        result = result.split(bad).join(replacement)
    }
    return result
}

/**
 * Collect the specific bad substrings found in a string.
 */
function findBadStrings(str) {
    if (!str) return []
    const found = new Set()
    for (const [bad] of REPLACEMENTS) {
        if (str.includes(bad)) found.add(bad)
    }
    // Also detect with regex
    const matches = str.match(/[\xC2\xC3][\x80-\xBF]/gu) || []
    matches.forEach((m) => found.add(m))
    return [...found]
}

// ── DB ────────────────────────────────────────────────────────────────────────
function dbQuery(sql, args = []) {
    const pool = mysql.createPool({
        connectionLimit: 1,
        host: DB_WRITE_HOST,
        user: DB_USER,
        password: DB_PASSWORD,
        port: 3306,
        database: 'main',
        timezone: '+00:00',
    })
    return new Promise((resolve, reject) => {
        pool.query(sql, args, (err, results) => {
            pool.end()
            if (err) return reject(err)
            resolve(results)
        })
    })
}

// ── Shopify ───────────────────────────────────────────────────────────────────
async function shopifyGraphQL(storeInfo, queryStr, variables = {}) {
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
    const json = await res.json()
    if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`)
    return json.data
}

// Metafield keys to scan (all in "custom" namespace)
const METAFIELD_KEYS = ['specifications', 'features', 'warranty', 'checkmarks', 'package_contents', 'manuals']

async function fetchAllProducts(storeInfo) {
    const products = []
    let cursor = null
    let page = 0
    const vendorFilter = VENDOR_ARG ? ` vendor:'${VENDOR_ARG}'` : ''
    const handleFilter = HANDLE_ARG ? ` handle:'${HANDLE_ARG}'` : ''

    do {
        page++
        const data = await shopifyGraphQL(
            storeInfo,
            `query getProducts($cursor: String) {
                products(first: ${PAGE_SIZE}, after: $cursor, query: "status:active${vendorFilter}${handleFilter}") {
                    pageInfo { hasNextPage }
                    edges {
                        cursor
                        node {
                            id
                            handle
                            title
                            vendor
                            descriptionHtml
                            seo {
                                description
                            }
                            metafields(first: 20, namespace: "custom") {
                                nodes {
                                    key
                                    namespace
                                    value
                                    type
                                }
                            }
                        }
                    }
                }
            }`,
            { cursor }
        )

        const edges = data.products.edges
        for (const edge of edges) products.push(edge.node)

        const hasNextPage = data.products.pageInfo.hasNextPage
        cursor = hasNextPage ? edges[edges.length - 1].cursor : null
        console.log(`  Page ${page}: fetched ${edges.length} products (${products.length} total)`)
    } while (cursor)

    return products
}

async function fixProduct(storeInfo, productId, fields) {
    // fields: { descriptionHtml?, title?, seoDescription?, metafields?: [{id, value}] }
    const input = { id: productId }
    if (fields.title !== undefined) input.title = fields.title
    if (fields.descriptionHtml !== undefined) input.descriptionHtml = fields.descriptionHtml
    if (fields.seoDescription !== undefined) {
        input.seo = { description: fields.seoDescription }
    }

    // Fix core product fields
    const data = await shopifyGraphQL(
        storeInfo,
        `mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
                product { id }
                userErrors { field message }
            }
        }`,
        { input }
    )
    const errors = data.productUpdate.userErrors
    if (errors.length > 0) {
        console.error(`  productUpdate errors for ${productId}:`, errors)
        return false
    }

    // Fix metafields separately via metafieldsSet
    if (fields.metafields?.length) {
        const mfData = await shopifyGraphQL(
            storeInfo,
            `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
                metafieldsSet(metafields: $metafields) {
                    metafields { id key value }
                    userErrors { field message }
                }
            }`,
            { metafields: fields.metafields }
        )
        const mfErrors = mfData.metafieldsSet.userErrors
        if (mfErrors.length > 0) {
            console.error(`  metafieldsSet errors for ${productId}:`, mfErrors)
            return false
        }
    }

    return true
}

// ── CSV ───────────────────────────────────────────────────────────────────────
function escapeCsv(val) {
    const s = String(val ?? '')
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`
    }
    return s
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const [storeInfo] = await dbQuery(`SELECT * FROM stores WHERE id = ?`, [STORE_ID])
    if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)

    const suffix = [VENDOR_ARG && `vendor: ${VENDOR_ARG}`, HANDLE_ARG && `handle: ${HANDLE_ARG}`]
        .filter(Boolean)
        .join(', ')
    console.log(`Fetching products${suffix ? ` (${suffix})` : ''}...`)
    const products = await fetchAllProducts(storeInfo)
    console.log(`\nScanning ${products.length} products for double-encoded UTF-8...\n`)

    const issues = []

    for (const product of products) {
        const checks = [
            { field: 'title', value: product.title },
            { field: 'descriptionHtml', value: product.descriptionHtml },
            { field: 'seoDescription', value: product.seo?.description },
        ]

        // Add metafield checks
        const metaNodes = product.metafields?.nodes || []
        for (const mf of metaNodes) {
            if (!METAFIELD_KEYS.includes(mf.key)) continue
            // list.* metafields store a JSON array of strings
            if (mf.type.startsWith('list.')) {
                let items
                try {
                    items = JSON.parse(mf.value)
                } catch {
                    continue
                }
                if (!Array.isArray(items)) continue
                // Check if any item in the array has issues
                const combined = items.join('\n')
                checks.push({ field: `metafield:${mf.key}`, value: combined, metaNode: mf, isList: true, items })
            } else {
                checks.push({ field: `metafield:${mf.key}`, value: mf.value, metaNode: mf, isList: false })
            }
        }

        const productIssues = []
        const fixes = {}
        const metafieldFixes = []

        for (const check of checks) {
            const { field, value } = check
            if (!hasDoubleEncoding(value)) continue

            const badStrings = findBadStrings(value)
            productIssues.push({ field, badStrings })

            if (check.metaNode) {
                // For metafields, fix each item individually; use plain dash (non-description)
                if (check.isList) {
                    const fixedItems = check.items.map((item) => fixDoubleEncoding(item, true))
                    metafieldFixes.push({
                        ownerId: product.id,
                        namespace: check.metaNode.namespace,
                        key: check.metaNode.key,
                        value: JSON.stringify(fixedItems),
                        type: check.metaNode.type,
                    })
                } else {
                    metafieldFixes.push({
                        ownerId: product.id,
                        namespace: check.metaNode.namespace,
                        key: check.metaNode.key,
                        value: fixDoubleEncoding(value, true),
                        type: check.metaNode.type,
                    })
                }
            } else {
                // descriptionHtml keeps proper Unicode dashes; title/seoDescription use plain dash
                const isDesc = field === 'descriptionHtml'
                fixes[field] = fixDoubleEncoding(value, !isDesc)
            }
        }

        if (productIssues.length === 0) continue

        const handle = product.handle
        console.log(`  [ISSUE] ${handle} (${product.vendor})`)
        for (const { field, badStrings } of productIssues) {
            console.log(`    - ${field}: ${badStrings.map((s) => JSON.stringify(s)).join(', ')}`)
            issues.push({
                handle,
                vendor: product.vendor,
                productId: product.id,
                field,
                badStrings: badStrings.join(' | '),
            })
        }

        if (FIX_MODE) {
            if (metafieldFixes.length) fixes.metafields = metafieldFixes
            const ok = await fixProduct(storeInfo, product.id, fixes)
            console.log(`    → Fix ${ok ? 'applied ✓' : 'FAILED ✗'}`)
        }
    }

    // Write CSV
    const csvRows = [
        ['handle', 'vendor', 'productId', 'field', 'badStrings'].join(','),
        ...issues.map((r) => [r.handle, r.vendor, r.productId, r.field, r.badStrings].map(escapeCsv).join(',')),
    ]
    fs.writeFileSync(OUT_FILE, csvRows.join('\n'), 'utf8')

    console.log(`\n─────────────────────────────────────────`)
    console.log(`Products scanned : ${products.length}`)
    console.log(`Products affected: ${new Set(issues.map((i) => i.handle)).size}`)
    console.log(`Total fields     : ${issues.length}`)
    if (FIX_MODE) console.log(`Mode             : FIX (changes applied)`)
    else console.log(`Mode             : SCAN only (re-run with --fix to apply)`)
    console.log(`Report written   : ${OUT_FILE}`)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
