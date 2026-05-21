import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import mysql from 'mysql'
import fs from 'fs'
import { parse } from 'csv-parse/sync'

/**
 * Automated Vevor Product Grouping Script
 *
 * Scrapes Vevor product pages to discover variant groups, matches SKUs to
 * products in the database, creates groups in the DB, and updates Shopify metafields.
 *
 * Usage:
 *   node --input-type=module scripts/groupVevorProducts.js [product_type] [--dry-run]
 *
 * Examples:
 *   node --input-type=module scripts/groupVevorProducts.js "Ultrasonic Cleaners"
 *   node --input-type=module scripts/groupVevorProducts.js "Ultrasonic Cleaners" --dry-run
 */

// ── Config ──────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2025-01'
const PRODUCT_TYPE_FILTER = process.env.PRODUCT_TYPE || process.argv[2] || null
const DRY_RUN = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run')
const MAX_GROUP_SIZE = 10 // Don't create groups larger than this
const SCRAPE_DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS) || 1000

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
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

// ── Vevor Scraping ──────────────────────────────────────────────────────────
function extractWindowJSON(html, varName) {
    const marker = `window.${varName} = `
    const start = html.indexOf(marker)
    if (start === -1) return null
    const jsonStart = start + marker.length
    const firstChar = html[jsonStart]

    if (firstChar === '{') {
        let depth = 0
        for (let i = jsonStart; i < html.length; i++) {
            if (html[i] === '{') depth++
            else if (html[i] === '}') {
                depth--
                if (depth === 0) return JSON.parse(html.substring(jsonStart, i + 1))
            }
        }
    } else if (firstChar === '[') {
        let depth = 0
        for (let i = jsonStart; i < html.length; i++) {
            if (html[i] === '[') depth++
            else if (html[i] === ']') {
                depth--
                if (depth === 0) return JSON.parse(html.substring(jsonStart, i + 1))
            }
        }
    }
    return null
}

async function scrapeVevorPage(productUrl) {
    const res = await fetch(productUrl, {
        headers: HEADERS,
        signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`Failed to fetch ${productUrl}: ${res.status}`)
    const html = await res.text()

    const attrList = extractWindowJSON(html, 'DETAIL_ATTR_LIST')
    const attrLink = extractWindowJSON(html, 'DETAIL_ATTR_LINK')
    const productData = extractWindowJSON(html, 'PRODUCT_DATA')

    if (!attrList) return null // No variant groups on this page

    const groups = Object.entries(attrList).map(([groupName, group]) => ({
        name: group.attrName || groupName,
        showImg: group.showImg || false,
        options: Object.values(group.list).map((opt) => ({
            value: opt.value,
            sku: opt.goodSn,
            url: opt.url,
            prime: opt.prime,
        })),
    }))

    // Build prime lookup for multi-option variant resolution
    const allPrimes = {}
    for (const group of groups) {
        for (const opt of group.options) {
            allPrimes[opt.prime] = { group: group.name, value: opt.value }
        }
    }

    const variants = (attrLink || []).map((link) => {
        const options = {}
        let remaining = link.prime
        for (const [p, info] of Object.entries(allPrimes)) {
            const prime = parseInt(p)
            if (remaining % prime === 0) {
                options[info.group] = info.value
                remaining /= prime
            }
        }
        return {
            sku: link.goodSn,
            url: link.url,
            options,
        }
    })

    return {
        title: productData?.title || null,
        currentSku: productData?.goodsSn || null,
        groups,
        variants,
    }
}

// ── Shopify ─────────────────────────────────────────────────────────────────
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

async function updateShopifyMetafields(storeInfo, metafields) {
    if (DRY_RUN) {
        console.log(`  [DRY RUN] Would update ${metafields.length} metafield(s) on Shopify`)
        return
    }

    // Batch in groups of 25 (Shopify limit)
    for (let i = 0; i < metafields.length; i += 25) {
        const batch = metafields.slice(i, i + 25)
        const result = await shopifyGraphQL(
            storeInfo,
            `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) { 
                metafieldsSet(metafields: $metafields) { 
                    userErrors { field message } 
                }
            }`,
            { metafields: batch }
        )
        if (result.data?.metafieldsSet?.userErrors?.length > 0) {
            console.error('  Shopify metafield errors:', result.data.metafieldsSet.userErrors)
        }
    }
}

// ── Group Name Generation ───────────────────────────────────────────────────
const usedGroupNumbers = new Map() // baseGroupName -> max number used this run

async function removeFromCurrentGroup(pool, productId) {
    // Delete option values tied to this product's group link
    const links = await query(pool, `SELECT id FROM group_product_links WHERE product_id = ? AND store_id = ?`, [
        productId,
        STORE_ID,
    ])
    for (const link of links) {
        await query(pool, `DELETE FROM product_group_options WHERE product_link_id = ?`, [link.id])
    }
    // Delete the group link itself
    await query(pool, `DELETE FROM group_product_links WHERE product_id = ? AND store_id = ?`, [productId, STORE_ID])
}

async function getNextGroupNumber(pool, baseGroupName) {
    const existing = await query(
        pool,
        `SELECT group_name FROM product_groups WHERE store_id = ? AND group_name LIKE ?`,
        [STORE_ID, `${baseGroupName} Auto G%`]
    )

    let maxNum = 0
    for (const row of existing) {
        const match = row.group_name.match(/G(\d+)$/)
        if (match) maxNum = Math.max(maxNum, parseInt(match[1]))
    }

    // Track numbers used during this run (important for dry-run and multi-group runs)
    const runMax = usedGroupNumbers.get(baseGroupName) || 0
    maxNum = Math.max(maxNum, runMax)
    const nextNum = maxNum + 1
    usedGroupNumbers.set(baseGroupName, nextNum)
    return nextNum
}

// ── Main Logic ──────────────────────────────────────────────────────────────
async function main() {
    const pool = createPool()

    try {
        console.log(`\n═══ Vevor Product Grouping ═══`)
        console.log(`Product Type: ${PRODUCT_TYPE_FILTER || 'ALL'}`)
        console.log(`Dry Run: ${DRY_RUN}\n`)

        // 1. Load SKU -> product type mapping from CSV
        const mappingCsv = fs.readFileSync(new URL('./vevor_sku_type_mapping.csv', import.meta.url), 'utf-8')
        const mappingRows = parse(mappingCsv, {
            columns: true,
            skip_empty_lines: true,
            relax_column_count: true,
        })

        const targetSkus = new Set()
        for (const row of mappingRows) {
            const mappedType = (row['Mapped Product Type'] || '').trim()
            if (!PRODUCT_TYPE_FILTER || mappedType === PRODUCT_TYPE_FILTER) {
                const sku = (row['SKU'] || '').trim()
                if (sku) targetSkus.add(sku)
            }
        }
        console.log(`Found ${targetSkus.size} SKUs in CSV for "${PRODUCT_TYPE_FILTER || 'ALL'}"`)
        if (targetSkus.size === 0) {
            console.log('No SKUs found for this product type. Exiting.')
            return
        }

        // 2. Get store info
        const [storeInfo] = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)

        // 3. Get all products in the DB matching those SKUs (with weblinks)
        const allMatchingProducts = await query(
            pool,
            `SELECT p.id, p.title, p.product_type, p.admin_graphql_api_id, p.custom_group,
                    vn.sku, vn.custom_weblinks
             FROM products p
             LEFT JOIN variants_new vn ON vn.product_id = p.id
             WHERE p.vendor = 'Vevor' AND vn.sku IS NOT NULL
             ORDER BY p.id`
        )

        // Build SKU -> product map (only for SKUs from the CSV)
        const skuToProduct = new Map()
        const ungroupedProducts = []
        for (const p of allMatchingProducts) {
            if (targetSkus.has(p.sku)) {
                skuToProduct.set(p.sku, p)
                if (!p.custom_group && p.custom_weblinks && p.custom_weblinks !== '[]') {
                    ungroupedProducts.push(p)
                }
            }
        }

        console.log(`Matched ${skuToProduct.size} SKUs to products in DB`)
        console.log(`Found ${ungroupedProducts.length} ungrouped product(s) with weblinks\n`)
        if (ungroupedProducts.length === 0) {
            console.log('Nothing to group. Exiting.')
            return
        }

        // 4. Get already-grouped product IDs to avoid re-grouping
        const alreadyGrouped = await query(pool, `SELECT product_id FROM group_product_links WHERE store_id = ?`, [
            STORE_ID,
        ])
        const groupedProductIds = new Set(alreadyGrouped.map((r) => r.product_id))

        // 5. Track which products we've already processed (via scrape)
        const processedProductIds = new Set()
        const scrapedUrls = new Map() // url -> scrapeResult (cache to avoid re-scraping same page)

        let groupsCreated = 0
        let productsGrouped = 0

        // 6. Process each ungrouped product
        for (const product of ungroupedProducts) {
            if (processedProductIds.has(product.id)) {
                console.log(`  [SKIP] ${product.sku} - already processed this run`)
                continue
            }
            if (groupedProductIds.has(product.id)) {
                console.log(`  [SKIP] ${product.sku} - already in group_product_links`)
                processedProductIds.add(product.id)
                continue
            }

            // Parse weblinks to get Vevor URL
            let vevorUrl = null
            try {
                const weblinks = JSON.parse(product.custom_weblinks)
                const link = weblinks.find((w) => typeof w.link === 'string' && w.link.includes('vevor.com'))
                if (link) vevorUrl = link.link
            } catch (e) {
                console.log(`  [SKIP] ${product.sku} - weblinks JSON parse error: ${e.message}`)
                continue
            }
            if (!vevorUrl) {
                console.log(`  [SKIP] ${product.sku} - no vevor.com URL in weblinks`)
                continue
            }

            console.log(`\n─── Processing: ${product.title} ───`)
            console.log(`  SKU: ${product.sku}`)
            console.log(`  URL: ${vevorUrl}`)

            // Scrape the Vevor page (use cache)
            let scrapeResult = scrapedUrls.get(vevorUrl)
            if (!scrapeResult) {
                try {
                    scrapeResult = await scrapeVevorPage(vevorUrl)
                    scrapedUrls.set(vevorUrl, scrapeResult)
                } catch (err) {
                    console.error(`  ✗ Scrape failed: ${err.message}`)
                    processedProductIds.add(product.id)
                    continue
                }
            }

            if (!scrapeResult || scrapeResult.variants.length <= 1) {
                console.log(`  → No variant group found (single product or no attrs)`)
                processedProductIds.add(product.id)
                continue
            }

            // Match scraped variant SKUs to products in our DB
            const matchedProducts = []
            for (const variant of scrapeResult.variants) {
                const dbProduct = skuToProduct.get(variant.sku)
                if (dbProduct) {
                    matchedProducts.push({
                        ...dbProduct,
                        variantOptions: variant.options,
                    })
                } else {
                    console.log(`    [MISS] Variant SKU ${variant.sku} not found in DB`)
                }
            }

            // Need at least 2 products to form a group
            if (matchedProducts.length < 2) {
                console.log(`  → Only ${matchedProducts.length} matching product(s) in DB, need at least 2`)
                processedProductIds.add(product.id)
                continue
            }

            // Cap group size
            const groupProducts = matchedProducts.slice(0, MAX_GROUP_SIZE)

            // Determine group name: "Vevor [Product Type] G[N]"
            const productType = product.product_type || 'Products'
            const baseGroupName = `Vevor ${productType}`
            const groupNum = await getNextGroupNumber(pool, baseGroupName)
            const groupName = `${baseGroupName} G${groupNum}`

            // Determine option names from the scraped groups
            const optionNames = scrapeResult.groups.map((g) => `${g.name} Options`)

            console.log(`  → Creating group: "${groupName}"`)
            console.log(`  → Options: ${optionNames.join(', ')}`)
            console.log(`  → Products (${groupProducts.length}):`)
            for (const mp of groupProducts) {
                const optVals = Object.entries(mp.variantOptions)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(', ')
                console.log(`    • ${mp.title} [${mp.sku}] → ${optVals}`)
            }

            if (!DRY_RUN) {
                // Check if any of these products are already in a group together
                const productIds = groupProducts.map((mp) => mp.id)
                const existingLinks = await query(
                    pool,
                    `SELECT product_id, group_id FROM group_product_links WHERE store_id = ? AND product_id IN (?)`,
                    [STORE_ID, productIds]
                )

                // Find a group that already contains one or more of these products
                let existingGroupId = null
                let existingGroupName = null
                if (existingLinks.length > 0) {
                    // Use the group that has the most overlap with our product list
                    const groupCounts = {}
                    for (const link of existingLinks) {
                        groupCounts[link.group_id] = (groupCounts[link.group_id] || 0) + 1
                    }
                    existingGroupId = Number(Object.entries(groupCounts).sort((a, b) => b[1] - a[1])[0][0])
                    const [groupRow] = await query(pool, `SELECT group_name FROM product_groups WHERE id = ?`, [
                        existingGroupId,
                    ])
                    existingGroupName = groupRow ? groupRow.group_name : groupName
                }

                if (existingGroupId) {
                    const groupId = existingGroupId
                    console.log(
                        `  → Found existing group "${existingGroupName}" (id=${groupId}), adding missing products`
                    )

                    // Get products already in this group
                    const alreadyInGroup = await query(
                        pool,
                        `SELECT product_id FROM group_product_links WHERE group_id = ? AND store_id = ?`,
                        [groupId, STORE_ID]
                    )
                    const alreadyInGroupIds = new Set(alreadyInGroup.map((r) => r.product_id))

                    // Filter to only products not already in this group
                    const newProducts = groupProducts.filter((mp) => !alreadyInGroupIds.has(mp.id))

                    if (newProducts.length === 0) {
                        console.log(`    All products already in group, skipping`)
                        for (const mp of groupProducts) {
                            processedProductIds.add(mp.id)
                            groupedProductIds.add(mp.id)
                        }
                        continue
                    }

                    console.log(`    Adding ${newProducts.length} new product(s) to existing group`)

                    // Get existing group options
                    const createdOptions = await query(
                        pool,
                        `SELECT id, option_name, position FROM group_options WHERE group_id = ? ORDER BY position`,
                        [groupId]
                    )

                    const shopifyMetafields = []
                    for (const mp of newProducts) {
                        // Remove from any current group first
                        await removeFromCurrentGroup(pool, mp.id)

                        const linkResult = await query(
                            pool,
                            `INSERT IGNORE INTO group_product_links(product_id, group_id, store_id) VALUES (?, ?, ?)`,
                            [mp.id, groupId, STORE_ID]
                        )
                        const productLinkId =
                            linkResult.affectedRows > 0
                                ? linkResult.insertId
                                : (
                                      await query(
                                          pool,
                                          `SELECT id FROM group_product_links WHERE product_id = ? AND group_id = ?`,
                                          [mp.id, groupId]
                                      )
                                  )[0].id

                        // Create option values for this product
                        const optionValueInserts = []
                        const optionValueStrings = []
                        for (const option of createdOptions) {
                            const scrapedGroupName = option.option_name.replace(' Options', '')
                            const value = mp.variantOptions[scrapedGroupName] || ''
                            if (value) {
                                optionValueInserts.push([productLinkId, option.id, value, STORE_ID])
                                optionValueStrings.push(`${option.option_name}:${value}`)
                            }
                        }

                        if (optionValueInserts.length > 0) {
                            await query(
                                pool,
                                `INSERT INTO product_group_options(product_link_id, option_id, option_value, store_id) VALUES ?`,
                                [optionValueInserts]
                            )
                        }

                        await query(pool, `UPDATE products SET custom_group = ? WHERE id = ?`, [
                            existingGroupName,
                            mp.id,
                        ])
                        const customOptionsValue = JSON.stringify(optionValueStrings)
                        await query(pool, `UPDATE products SET custom_options = ? WHERE id = ?`, [
                            customOptionsValue,
                            mp.id,
                        ])

                        shopifyMetafields.push({
                            ownerId: mp.admin_graphql_api_id,
                            namespace: 'custom',
                            key: 'group',
                            type: 'single_line_text_field',
                            value: existingGroupName,
                        })
                        shopifyMetafields.push({
                            ownerId: mp.admin_graphql_api_id,
                            namespace: 'custom',
                            key: 'options',
                            type: 'list.single_line_text_field',
                            value: JSON.stringify(optionValueStrings),
                        })

                        groupedProductIds.add(mp.id)
                        processedProductIds.add(mp.id)
                    }

                    // Mark already-grouped products as processed
                    for (const mp of groupProducts.filter((p) => alreadyInGroupIds.has(p.id))) {
                        processedProductIds.add(mp.id)
                        groupedProductIds.add(mp.id)
                    }

                    if (shopifyMetafields.length > 0) {
                        await updateShopifyMetafields(storeInfo, shopifyMetafields)
                    }
                    console.log(`  ✓ Added ${newProducts.length} product(s) to existing group "${existingGroupName}"`)
                    productsGrouped += newProducts.length
                    continue
                }

                // No existing group found — create new group
                const groupResult = await query(
                    pool,
                    `INSERT INTO product_groups(group_name, store_id) VALUES (?, ?)`,
                    [groupName, STORE_ID]
                )
                const groupId = groupResult.insertId

                // Create group options
                const optionInserts = optionNames.map((name, idx) => [name, groupId, STORE_ID, idx])
                await query(pool, `INSERT INTO group_options(option_name, group_id, store_id, position) VALUES ?`, [
                    optionInserts,
                ])

                // Get the created option IDs
                const createdOptions = await query(
                    pool,
                    `SELECT id, option_name, position FROM group_options WHERE group_id = ? ORDER BY position`,
                    [groupId]
                )

                // Create product links and option values
                const shopifyMetafields = []
                for (const mp of groupProducts) {
                    // Remove from any current group first
                    await removeFromCurrentGroup(pool, mp.id)

                    // Create product link (skip if already exists)
                    const linkResult = await query(
                        pool,
                        `INSERT IGNORE INTO group_product_links(product_id, group_id, store_id) VALUES (?, ?, ?)`,
                        [mp.id, groupId, STORE_ID]
                    )
                    if (linkResult.affectedRows === 0) {
                        // Already linked, fetch existing link ID
                        const [existing] = await query(
                            pool,
                            `SELECT id FROM group_product_links WHERE product_id = ? AND group_id = ?`,
                            [mp.id, groupId]
                        )
                        var productLinkId = existing.id
                    } else {
                        var productLinkId = linkResult.insertId
                    }

                    // Create option values for this product
                    const optionValueInserts = []
                    const optionValueStrings = []
                    for (const option of createdOptions) {
                        // Map the option name back to the scraped group name
                        const scrapedGroupName = option.option_name.replace(' Options', '')
                        const value = mp.variantOptions[scrapedGroupName] || ''
                        if (value) {
                            optionValueInserts.push([productLinkId, option.id, value, STORE_ID])
                            optionValueStrings.push(`${option.option_name}:${value}`)
                        }
                    }

                    if (optionValueInserts.length > 0) {
                        await query(
                            pool,
                            `INSERT INTO product_group_options(product_link_id, option_id, option_value, store_id) VALUES ?`,
                            [optionValueInserts]
                        )
                    }

                    // Update product metafield columns in DB
                    await query(pool, `UPDATE products SET custom_group = ? WHERE id = ?`, [groupName, mp.id])
                    const customOptionsValue = JSON.stringify(optionValueStrings)
                    await query(pool, `UPDATE products SET custom_options = ? WHERE id = ?`, [
                        customOptionsValue,
                        mp.id,
                    ])

                    // Prepare Shopify metafield updates
                    shopifyMetafields.push({
                        ownerId: mp.admin_graphql_api_id,
                        namespace: 'custom',
                        key: 'group',
                        type: 'single_line_text_field',
                        value: groupName,
                    })
                    shopifyMetafields.push({
                        ownerId: mp.admin_graphql_api_id,
                        namespace: 'custom',
                        key: 'options',
                        type: 'list.single_line_text_field',
                        value: JSON.stringify(optionValueStrings),
                    })

                    groupedProductIds.add(mp.id)
                    processedProductIds.add(mp.id)
                }

                // Update Shopify metafields
                await updateShopifyMetafields(storeInfo, shopifyMetafields)
                console.log(`  ✓ Group "${groupName}" created with ${groupProducts.length} products`)
            } else {
                // Mark as processed in dry run
                for (const mp of groupProducts) {
                    processedProductIds.add(mp.id)
                }
                console.log(`  [DRY RUN] Would create group "${groupName}" with ${groupProducts.length} products`)
            }

            groupsCreated++
            productsGrouped += groupProducts.length

            // Rate limit: wait between scrapes
            await new Promise((resolve) => setTimeout(resolve, SCRAPE_DELAY_MS))
        }

        console.log(`\n═══ Summary ═══`)
        console.log(`Groups created: ${groupsCreated}`)
        console.log(`Products grouped: ${productsGrouped}`)
        if (DRY_RUN) console.log(`(DRY RUN - no changes made)`)
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
