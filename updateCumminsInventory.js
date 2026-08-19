/**
 * updateCumminsInventory.js
 *
 * Reads cummins.xlsx (3 sheets: Liquid Cooled, Diesel, Diesel - No Enclosure)
 * and for each listed Cummins product (matched by SKU / Part Number):
 *
 *  1. Updates Shopify inventory:  In Stock → 100 units, Out of Stock → 0
 *  2. Upserts processing_times record in fpdash DB (one per unique lead time)
 *  3. Upserts processing_times_connections linking the product GID to its time
 *  4. Pushes custom.processing_time metafield to Shopify on the product
 *
 * Processing time format (per product page design):
 *   pdp_line_1: "Ships in (EST) 3-5 business days"  |  "Ships in (EST) 18 weeks"
 *   pdp_line_2: "Manufacturer Direct Shipping"
 *
 * Usage:
 *   node updateCumminsInventory.js                # live run
 *   node updateCumminsInventory.js --dry-run      # preview only, no writes
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import { fileURLToPath } from 'url'
import path from 'path'
import XLSX from 'xlsx'
import fetch from 'node-fetch'
import mysql from 'mysql'

// ── Config ──────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2026-01'
const DRY_RUN = process.argv.includes('--dry-run')
const CONCURRENCY = 3

const limitArgIdx = process.argv.indexOf('--limit')
const LIMIT = (() => {
    const eqArg = process.argv.find((a) => a.startsWith('--limit='))
    if (eqArg) return parseInt(eqArg.split('=')[1]) || 1
    if (limitArgIdx !== -1) return parseInt(process.argv[limitArgIdx + 1]) || 1
    return Infinity
})()

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Format a raw lead-time string into a pretty display message.
 * "3-5 days"  → "Ships in (EST) 3-5 business days"
 * "18 weeks"  → "Ships in (EST) 18 weeks"
 */
function formatLeadTime(raw) {
    const trimmed = raw.trim()
    // If it has "day(s)" but not already "business", prepend "business"
    if (/days?/i.test(trimmed) && !/business/i.test(trimmed)) {
        return 'Ships in (EST) ' + trimmed.replace(/days?/i, 'business days')
    }
    return 'Ships in (EST) ' + trimmed
}

/**
 * Slugify a lead time into a stable processing_times name.
 * "3-5 days" → "Cummins | Ships in (EST) 3-5 business days"
 */
function processingTimeName(pdpLine1) {
    return `Cummins | ${pdpLine1}`
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

// ── Shopify ─────────────────────────────────────────────────────────────────
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

/**
 * Paginate all Cummins variants from Shopify.
 * Returns Map<sku, { productGid, variantGid, inventoryItemId }>
 */
async function fetchCumminsVariants(storeInfo) {
    const variantMap = new Map()
    let cursor = null
    let page = 0

    do {
        page++
        const data = await shopifyGraphQL(
            storeInfo,
            `query getProducts($cursor: String) {
                products(first: 250, after: $cursor, query: "vendor:'Cummins'") {
                    pageInfo { hasNextPage }
                    edges {
                        cursor
                        node {
                            id
                            variants(first: 10) {
                                nodes {
                                    id
                                    sku
                                    inventoryItem { id }
                                }
                            }
                        }
                    }
                }
            }`,
            { cursor }
        )

        const edges = data.products.edges
        for (const edge of edges) {
            for (const v of edge.node.variants.nodes) {
                const sku = (v.sku || '').trim()
                if (!sku) continue
                variantMap.set(sku, {
                    productGid: edge.node.id,
                    variantGid: v.id,
                    inventoryItemId: v.inventoryItem?.id || null,
                })
            }
        }

        const hasNextPage = data.products.pageInfo.hasNextPage
        cursor = hasNextPage ? edges[edges.length - 1].cursor : null
        console.log(`  [Cummins] page ${page}: ${edges.length} products (${variantMap.size} total variants)`)
    } while (cursor)

    return variantMap
}

/** Get primary Shopify location ID */
async function getPrimaryLocationId(storeInfo) {
    const data = await shopifyGraphQL(storeInfo, `query { locations(first: 1) { edges { node { id name } } } }`)
    const loc = data.locations.edges[0]?.node
    if (!loc) throw new Error('No location found in Shopify store')
    console.log(`Using location: ${loc.name} (${loc.id})`)
    return loc.id
}

/** Set absolute inventory quantity */
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

/** Set inventory policy (CONTINUE = sell when OOS, DENY = block when OOS) */
async function updateInventoryPolicy({ storeInfo, productGid, variantGid, inventoryPolicy }) {
    const data = await shopifyGraphQL(
        storeInfo,
        `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                userErrors { field message }
            }
        }`,
        { productId: productGid, variants: [{ id: variantGid, inventoryPolicy }] }
    )
    const errors = data.productVariantsBulkUpdate?.userErrors
    if (errors?.length > 0) throw new Error(`Inventory policy errors: ${JSON.stringify(errors)}`)
}

/**
 * Push custom.processing_time metafield (JSON) to a Shopify product.
 * This is what the front end reads for the PDP shipping message.
 */
async function setProcessingTimeMetafield({ storeInfo, productGid, processingTimeName, pdpLine1, pdpLine2 }) {
    const data = await shopifyGraphQL(
        storeInfo,
        `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
                metafields { value }
                userErrors { field message }
            }
        }`,
        {
            metafields: [
                {
                    ownerId: productGid,
                    namespace: 'custom',
                    key: 'processing_time',
                    type: 'json',
                    value: JSON.stringify({
                        name: processingTimeName,
                        pdp_line_1: pdpLine1,
                        pdp_line_2: pdpLine2,
                    }),
                },
            ],
        }
    )
    const errors = data.metafieldsSet?.userErrors
    if (errors?.length > 0) throw new Error(`Metafield set errors: ${JSON.stringify(errors)}`)
}

// ── Concurrency limiter ──────────────────────────────────────────────────────
async function runWithConcurrency(tasks, limit) {
    const results = []
    let i = 0
    async function run() {
        while (i < tasks.length) {
            const idx = i++
            results[idx] = await tasks[idx]()
        }
    }
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, run)
    await Promise.all(workers)
    return results
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n═══ Update Cummins Inventory & Processing Times ═══')
    console.log(`Dry Run: ${DRY_RUN}\n`)

    // 1. Load cummins.xlsx
    const __dirname = path.dirname(fileURLToPath(import.meta.url))
    const xlsxPath = path.join(__dirname, 'cummins.xlsx')
    const wb = XLSX.readFile(xlsxPath)

    // Parse all 3 sheets. Row 0 = sheet title, Row 1 = column headers, Row 2+ = data
    const SHEETS = ['Liquid Cooled', 'Diesel', 'Diesel - No Enclosure']
    const rows = []
    for (const sheetName of SHEETS) {
        const ws = wb.Sheets[sheetName]
        if (!ws) {
            console.warn(`⚠  Sheet "${sheetName}" not found in cummins.xlsx — skipping`)
            continue
        }
        const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
        // Row 0 = sheet title, Row 1 = column headers, Row 2+ = data
        const headers = raw[1]
        if (!headers) continue
        for (let r = 2; r < raw.length; r++) {
            const row = {}
            headers.forEach((h, i) => {
                row[h] = raw[r][i] ?? ''
            })
            // Normalize header variants ("In stock?" vs "In Stock?")
            row._sheet = sheetName
            rows.push(row)
        }
    }
    console.log(`Loaded ${rows.length} rows from cummins.xlsx`)

    // 2. Build SKU → { quantity, leadTimeRaw, pdpLine1, pdpLine2 } map
    const skuData = new Map()
    for (const row of rows) {
        const sku = (row['Part Number'] || '').trim()
        if (!sku) continue

        const inStockRaw = (row['In stock?'] || row['In Stock?'] || '').trim().toLowerCase()
        const quantity = inStockRaw === 'yes' ? 100 : 0
        const leadTimeRaw = (row['Lead-time'] || '').trim()
        const pdpLine1 = formatLeadTime(leadTimeRaw)
        const pdpLine2 = 'Manufacturer Direct Shipping'

        skuData.set(sku, { quantity, leadTimeRaw, pdpLine1, pdpLine2, sheet: row._sheet })
    }
    console.log(`Parsed ${skuData.size} unique SKUs from cummins.xlsx\n`)

    // Log what lead times we have
    const uniqueLeadTimes = new Map()
    for (const [, d] of skuData) {
        if (!uniqueLeadTimes.has(d.pdpLine1)) {
            uniqueLeadTimes.set(d.pdpLine1, d.pdpLine2)
        }
    }
    console.log('Unique lead times found:')
    for (const [lt] of uniqueLeadTimes) {
        console.log(`  • ${lt}`)
    }
    console.log()

    // 3. Get store info from DB
    const pool = createPool()
    try {
        const [storeInfo] = await query(pool, 'SELECT * FROM stores WHERE id = ?', [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)
        console.log(`Using store: ${storeInfo.shopify_name}\n`)

        // 4. Fetch Cummins variants from Shopify
        console.log('Fetching Cummins variants from Shopify...')
        const variantMap = await fetchCumminsVariants(storeInfo)
        console.log(`\nFetched ${variantMap.size} Cummins variant(s) from Shopify\n`)

        // 5. Match spreadsheet SKUs to Shopify variants
        const toUpdate = []
        let notFoundCount = 0
        for (const [sku, data] of skuData) {
            const shopify = variantMap.get(sku)
            if (!shopify) {
                console.warn(`  ⚠  SKU not found in Shopify: ${sku} (sheet: ${data.sheet})`)
                notFoundCount++
                continue
            }
            toUpdate.push({ sku, ...data, ...shopify })
        }
        console.log(`\n${toUpdate.length} SKU(s) matched to Shopify products (${notFoundCount} not found)\n`)
        if (LIMIT < Infinity) {
            toUpdate.splice(LIMIT)
            console.log(`--limit ${LIMIT}: processing only ${toUpdate.length} SKU(s)\n`)
        }

        if (toUpdate.length === 0) {
            console.log('Nothing to update.')
            return
        }

        // 6. Upsert processing_times in DB (one per unique lead-time message)
        //    Name = "Cummins | <pdpLine1>" — unique per lead time value
        if (!DRY_RUN) {
            console.log('Upserting processing_times in DB...')
            for (const [pdpLine1, pdpLine2] of uniqueLeadTimes) {
                const name = processingTimeName(pdpLine1)
                await query(
                    pool,
                    `INSERT INTO processing_times (name, type, pdp_line_1, pdp_line_2, status, store_id)
                     VALUES (?, 'PDP', ?, ?, 'ACTIVE', ?)
                     ON DUPLICATE KEY UPDATE
                         pdp_line_1 = VALUES(pdp_line_1),
                         pdp_line_2 = VALUES(pdp_line_2),
                         status = 'ACTIVE'`,
                    [name, pdpLine1, pdpLine2, STORE_ID]
                )
                console.log(`  ✓  Upserted processing_time: "${name}"`)
            }
        } else {
            console.log('[DRY-RUN] Would upsert processing_times:')
            for (const [pdpLine1] of uniqueLeadTimes) {
                console.log(`  • "${processingTimeName(pdpLine1)}"`)
            }
        }
        console.log()

        // 7. Load the processing_times IDs we just upserted
        const ptIdMap = new Map() // pdpLine1 → processing_times.id
        if (!DRY_RUN) {
            const names = [...uniqueLeadTimes.keys()].map(processingTimeName)
            const pts = await query(
                pool,
                `SELECT id, pdp_line_1 FROM processing_times WHERE name IN (?) AND store_id = ?`,
                [names, STORE_ID]
            )
            for (const pt of pts) ptIdMap.set(pt.pdp_line_1, pt.id)
        }

        // 8. Get Shopify location
        console.log('Fetching Shopify primary location...')
        const locationId = await getPrimaryLocationId(storeInfo)
        console.log()

        // 9. Process each SKU
        console.log(`Processing ${toUpdate.length} SKU(s)...\n`)

        const tasks = toUpdate.map((item) => async () => {
            const { sku, quantity, pdpLine1, pdpLine2, productGid, variantGid, inventoryItemId, sheet } = item
            const ptName = processingTimeName(pdpLine1)
            const ptId = ptIdMap.get(pdpLine1)

            if (DRY_RUN) {
                const policy = quantity === 0 ? 'CONTINUE' : 'DENY'
                console.log(
                    `[DRY-RUN] ${sku} (${sheet}): qty=${quantity}, policy=${policy}, processing="${ptName}", product=${productGid}`
                )
                return
            }

            try {
                // a) Set Shopify inventory quantity + selling policy
                const inventoryPolicy = quantity === 0 ? 'CONTINUE' : 'DENY'
                if (inventoryItemId) {
                    await setInventoryQuantity({ storeInfo, inventoryItemId, locationId, quantity })
                } else {
                    console.warn(`  ⚠  [${sku}] No inventoryItemId — skipping inventory quantity update`)
                }
                await updateInventoryPolicy({ storeInfo, productGid, variantGid, inventoryPolicy })

                // b) Push processing_time metafield to Shopify
                await setProcessingTimeMetafield({
                    storeInfo,
                    productGid,
                    processingTimeName: ptName,
                    pdpLine1,
                    pdpLine2,
                })

                // c) Upsert processing_times_connection in DB
                if (ptId) {
                    await query(
                        pool,
                        `INSERT INTO processing_times_connections
                             (processing_times_id, gid, resource_type, status, last_used, store_id)
                         VALUES (?, ?, 'Product', 'SUCCESS', NOW(), ?)
                         ON DUPLICATE KEY UPDATE
                             status = 'SUCCESS',
                             last_used = NOW()`,
                        [ptId, productGid, STORE_ID]
                    )
                } else {
                    console.warn(`  ⚠  [${sku}] Could not find processing_time ID for "${ptName}"`)
                }

                console.log(
                    `  ✓  ${sku} — qty: ${quantity}, policy: ${inventoryPolicy}, PT: "${pdpLine1}", product: ${productGid.split('/')[4]}`
                )
            } catch (err) {
                console.error(`  ✗  ${sku}: ${err.message}`)
            }
        })

        await runWithConcurrency(tasks, CONCURRENCY)

        console.log('\n═══ Done ═══')
        console.log(`Updated: ${toUpdate.length} SKU(s)`)
        console.log(`Not found in Shopify: ${notFoundCount} SKU(s)`)
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
