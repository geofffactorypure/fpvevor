import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import mysql from 'mysql'

/**
 * MechMaxx Product Grouping Script
 *
 * Scrapes MechMaxx product pages to discover the "Model" variant group selector,
 * matches handles to products in the DB, creates groups, and updates Shopify metafields.
 *
 * The .variants-bottom section on MechMaxx product pages lists all sibling products
 * in the same model family as clickable links, e.g.:
 *   TC9662 WB855 Combo → /products/24-rim-double-assist-arms-...
 *   TC964 WB855 Combo  → /products/1-5-hp-swing-arm-...
 *   ...
 *
 * Flow:
 *   1. Get all MechMaxx products from DB (handle + admin_graphql_api_id)
 *   2. Build handle → product map
 *   3. For each unprocessed product, fetch its MechMaxx page
 *   4. Parse .variants-bottom links → [{ handle, modelLabel }]
 *   5. Match handles to DB products
 *   6. Create/update group in DB and update custom.group + custom.options Shopify metafields
 *
 * Usage:
 *   node groupMechMaxxProducts.js [product_type] [--dry-run]
 *
 * Examples:
 *   node groupMechMaxxProducts.js
 *   node groupMechMaxxProducts.js "Tire Changers"
 *   node groupMechMaxxProducts.js "Tire Changers" --dry-run
 */

// ── Config ──────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2026-01'
const VENDOR = 'MechMaxx'
const MECHMAXX_BASE = 'https://mechmaxx.com'
const PRODUCT_TYPE_FILTER = process.env.PRODUCT_TYPE || process.argv[2] || null
const DRY_RUN = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run')
const MAX_GROUP_SIZE = 20
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

// ── Shopify ──────────────────────────────────────────────────────────────────
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

// ── Scraping ──────────────────────────────────────────────────────────────────

/**
 * Scrape the MechMaxx product page's .variants-bottom model selector.
 * Returns [{ handle, modelLabel }] for all products in the group,
 * or null if no group selector is present.
 *
 * Links in .variants-bottom are absolute:
 *   <a href="https://mechmaxx.com/products/[handle]">TC9662 WB855 Combo</a>
 */
async function scrapeModelGroup(productHandle) {
    const url = `${MECHMAXX_BASE}/products/${productHandle}`
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    const html = await res.text()

    const selectorIdx = html.indexOf('variants-bottom')
    if (selectorIdx === -1) return null

    const selectorSection = html.slice(selectorIdx, selectorIdx + 8000)

    // Match absolute mechmaxx.com product links with their label text
    const linkRegex = /<a\s+href="https:\/\/mechmaxx\.com\/products\/([^"]+)"[^>]*>([\s\S]+?)<\/a>/g
    const members = []
    let m
    while ((m = linkRegex.exec(selectorSection)) !== null) {
        const handle = m[1].trim()
        const label = m[2].replace(/<[^>]+>/g, '').trim() // strip any inner tags
        if (handle && label) members.push({ handle, label })
    }

    return members.length > 1 ? members : null
}

// ── Group Helpers ─────────────────────────────────────────────────────────────
const usedGroupNumbers = new Map()

async function getNextGroupNumber(pool, baseGroupName) {
    const existing = await query(
        pool,
        `SELECT group_name FROM product_groups WHERE store_id = ? AND group_name LIKE ?`,
        [STORE_ID, `${baseGroupName} G%`]
    )
    let maxNum = 0
    for (const row of existing) {
        const match = row.group_name.match(/G(\d+)$/)
        if (match) maxNum = Math.max(maxNum, parseInt(match[1]))
    }
    const runMax = usedGroupNumbers.get(baseGroupName) || 0
    maxNum = Math.max(maxNum, runMax)
    const nextNum = maxNum + 1
    usedGroupNumbers.set(baseGroupName, nextNum)
    return nextNum
}

async function removeFromCurrentGroup(pool, productId) {
    const links = await query(pool, `SELECT id FROM group_product_links WHERE product_id = ? AND store_id = ?`, [
        productId,
        STORE_ID,
    ])
    for (const link of links) {
        await query(pool, `DELETE FROM product_group_options WHERE product_link_id = ?`, [link.id])
    }
    await query(pool, `DELETE FROM group_product_links WHERE product_id = ? AND store_id = ?`, [productId, STORE_ID])
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const pool = createPool()

    try {
        console.log(`\n═══ MechMaxx Product Grouping ═══`)
        console.log(`Product Type: ${PRODUCT_TYPE_FILTER || 'ALL'}`)
        console.log(`Dry Run: ${DRY_RUN}\n`)

        // 1. Get store info
        const [storeInfo] = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)

        // 2. Get all MechMaxx products matching the filter
        let productQuery = `
            SELECT p.id, p.title, p.handle, p.product_type, p.admin_graphql_api_id,
                   vn.sku
            FROM products p
            JOIN variants_new vn ON vn.product_id = p.id
            WHERE p.vendor = ? AND p.store_id = ? AND vn.sku IS NOT NULL AND p.handle IS NOT NULL
        `
        const queryArgs = [VENDOR, STORE_ID]
        if (PRODUCT_TYPE_FILTER) {
            productQuery += ` AND p.product_type = ?`
            queryArgs.push(PRODUCT_TYPE_FILTER)
        }
        productQuery += ` ORDER BY p.id`

        const allMatchingProducts = await query(pool, productQuery, queryArgs)
        console.log(`Found ${allMatchingProducts.length} MechMaxx product(s)`)
        if (allMatchingProducts.length === 0) return

        // 3. Build handle → product map across all matching products
        //    (group members may span product types, so also load all MechMaxx handles)
        const allMechMaxx = await query(
            pool,
            `SELECT p.id, p.title, p.handle, p.product_type, p.admin_graphql_api_id, vn.sku
             FROM products p
             JOIN variants_new vn ON vn.product_id = p.id
             WHERE p.vendor = ? AND p.store_id = ? AND p.handle IS NOT NULL`,
            [VENDOR, STORE_ID]
        )
        const handleToProduct = new Map()
        for (const p of allMechMaxx) {
            handleToProduct.set(p.handle, p)
        }

        // 4. Get already-grouped product IDs to avoid re-grouping
        const alreadyGrouped = await query(pool, `SELECT product_id FROM group_product_links WHERE store_id = ?`, [
            STORE_ID,
        ])
        const groupedProductIds = new Set(alreadyGrouped.map((r) => r.product_id))

        const processedProductIds = new Set()
        const scrapedHandles = new Map() // cache: handle → scrape result

        let groupsCreated = 0
        let productsGrouped = 0

        // 5. Process each product
        for (const product of allMatchingProducts) {
            if (processedProductIds.has(product.id)) continue

            console.log(`\n─── ${product.title.slice(0, 70)} ───`)
            console.log(`  SKU: ${product.sku}`)

            // Scrape the MechMaxx page (use cache)
            let members = scrapedHandles.get(product.handle)
            if (members === undefined) {
                try {
                    members = await scrapeModelGroup(product.handle)
                    scrapedHandles.set(product.handle, members)
                } catch (err) {
                    console.error(`  ✗ Scrape failed: ${err.message}`)
                    processedProductIds.add(product.id)
                    continue
                }
                if (SCRAPE_DELAY_MS > 0) await new Promise((r) => setTimeout(r, SCRAPE_DELAY_MS))
            }

            if (!members) {
                console.log(`  → No model group selector found`)
                processedProductIds.add(product.id)
                continue
            }

            // Match scraped handles to DB products
            const matchedProducts = []
            for (const { handle, label } of members) {
                const dbProduct = handleToProduct.get(handle)
                if (dbProduct) {
                    matchedProducts.push({ ...dbProduct, modelLabel: label })
                } else {
                    console.log(`    [MISS] Handle "${handle}" not found in DB`)
                }
            }

            if (matchedProducts.length < 2) {
                console.log(`  → Only ${matchedProducts.length} product(s) matched in DB, need ≥2`)
                processedProductIds.add(product.id)
                continue
            }

            const groupProducts = matchedProducts.slice(0, MAX_GROUP_SIZE)
            const productType = product.product_type || 'Products'
            const baseGroupName = `MechMaxx ${productType} Auto`
            const optionName = 'Model Options'

            console.log(`  → Group: ${groupProducts.length} product(s) found:`)
            for (const mp of groupProducts) {
                console.log(`    • [${mp.sku}] ${mp.modelLabel}`)
            }

            if (!DRY_RUN) {
                // Check if any of these products already belong to an Auto group
                const productIds = groupProducts.map((mp) => mp.id)
                const existingLinks = await query(
                    pool,
                    `SELECT product_id, group_id FROM group_product_links WHERE store_id = ? AND product_id IN (?)`,
                    [STORE_ID, productIds]
                )

                let existingGroupId = null
                let groupName = null

                if (existingLinks.length > 0) {
                    const groupCounts = {}
                    for (const link of existingLinks) {
                        groupCounts[link.group_id] = (groupCounts[link.group_id] || 0) + 1
                    }
                    const sortedGroups = Object.entries(groupCounts).sort((a, b) => b[1] - a[1])
                    for (const [gId] of sortedGroups) {
                        const [groupRow] = await query(pool, `SELECT group_name FROM product_groups WHERE id = ?`, [
                            gId,
                        ])
                        if (groupRow?.group_name.includes('Auto')) {
                            existingGroupId = Number(gId)
                            groupName = groupRow.group_name
                            break
                        }
                    }
                }

                let finalGroupId = existingGroupId

                if (!existingGroupId) {
                    // Create new group
                    const groupNum = await getNextGroupNumber(pool, baseGroupName)
                    groupName = `${baseGroupName} G${groupNum}`
                    const groupResult = await query(
                        pool,
                        `INSERT INTO product_groups(group_name, store_id) VALUES (?, ?)`,
                        [groupName, STORE_ID]
                    )
                    finalGroupId = groupResult.insertId
                    await query(
                        pool,
                        `INSERT INTO group_options(option_name, group_id, store_id, position) VALUES (?, ?, ?, ?)`,
                        [optionName, finalGroupId, STORE_ID, 0]
                    )
                    console.log(`  → Creating new group: "${groupName}"`)
                } else {
                    console.log(`  → Adding to existing group: "${groupName}"`)
                }

                // Get group option row
                const [groupOption] = await query(
                    pool,
                    `SELECT id, option_name FROM group_options WHERE group_id = ? ORDER BY position`,
                    [finalGroupId]
                )

                // Find products not yet in this group
                const alreadyInGroup = await query(
                    pool,
                    `SELECT product_id FROM group_product_links WHERE group_id = ? AND store_id = ?`,
                    [finalGroupId, STORE_ID]
                )
                const alreadyInGroupIds = new Set(alreadyInGroup.map((r) => r.product_id))
                const newProducts = existingGroupId
                    ? groupProducts.filter((mp) => !alreadyInGroupIds.has(mp.id))
                    : groupProducts

                if (newProducts.length === 0) {
                    console.log(`    All products already in group, skipping`)
                    for (const mp of groupProducts) {
                        processedProductIds.add(mp.id)
                        groupedProductIds.add(mp.id)
                    }
                    groupsCreated++
                    continue
                }

                const shopifyMetafields = []

                for (const mp of newProducts) {
                    await removeFromCurrentGroup(pool, mp.id)

                    const linkResult = await query(
                        pool,
                        `INSERT IGNORE INTO group_product_links(product_id, group_id, store_id) VALUES (?, ?, ?)`,
                        [mp.id, finalGroupId, STORE_ID]
                    )
                    const productLinkId =
                        linkResult.affectedRows > 0
                            ? linkResult.insertId
                            : (
                                  await query(
                                      pool,
                                      `SELECT id FROM group_product_links WHERE product_id = ? AND group_id = ?`,
                                      [mp.id, finalGroupId]
                                  )
                              )[0].id

                    // Insert option value: modelLabel is the button text (e.g. "TC9662 WB855 Combo")
                    const optionValueString = `${groupOption.option_name}:${mp.modelLabel}`
                    await query(
                        pool,
                        `INSERT INTO product_group_options(product_link_id, option_id, option_value, store_id) VALUES (?, ?, ?, ?)`,
                        [productLinkId, groupOption.id, mp.modelLabel, STORE_ID]
                    )

                    await query(pool, `UPDATE products SET custom_group = ? WHERE id = ?`, [groupName, mp.id])
                    await query(pool, `UPDATE products SET custom_options = ? WHERE id = ?`, [
                        JSON.stringify([optionValueString]),
                        mp.id,
                    ])

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
                        value: JSON.stringify([optionValueString]),
                    })

                    groupedProductIds.add(mp.id)
                    processedProductIds.add(mp.id)
                }

                // Mark already-grouped products as processed too
                for (const mp of groupProducts.filter((p) => alreadyInGroupIds.has(p.id))) {
                    processedProductIds.add(mp.id)
                    groupedProductIds.add(mp.id)
                }

                if (shopifyMetafields.length > 0) {
                    await updateShopifyMetafields(storeInfo, shopifyMetafields)
                }

                const action = existingGroupId ? 'Updated' : 'Created'
                console.log(`  ✓ ${action} group "${groupName}" (+${newProducts.length} products)`)
                productsGrouped += newProducts.length
            } else {
                // Dry run
                const groupNum = await getNextGroupNumber(pool, baseGroupName)
                const groupName = `${baseGroupName} G${groupNum}`
                console.log(`  [DRY RUN] Would create group "${groupName}" with ${groupProducts.length} products`)
                for (const mp of groupProducts) processedProductIds.add(mp.id)
            }

            groupsCreated++
        }

        console.log(`\n── Summary ──────────────────────────────`)
        console.log(`  Groups created/updated: ${groupsCreated}`)
        console.log(`  Products grouped:        ${productsGrouped}`)
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
