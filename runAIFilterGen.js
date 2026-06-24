/**
 * Run AI Filter Generation for specific product IDs.
 *
 * Usage:
 *   node runAIFilterGen.js <product_id> [product_id...]
 *
 * Example:
 *   node runAIFilterGen.js 123 456 789
 *
 * This script:
 * 1. Looks up which collection(s) the given products belong to
 * 2. Gets the existing filter groups for each collection
 * 3. Runs OpenAI to determine filter values for each product
 * 4. Inserts the values directly into product_filter_values_new
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import mysql from 'mysql'
import OpenAI from 'openai'

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

const pool = mysql.createPool({
    connectionLimit: 3,
    host: DB_WRITE_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    port: 3306,
    database: 'main',
    timezone: '+00:00',
})

const query = (sql, args) =>
    new Promise((resolve, reject) => {
        pool.query(sql, args, (err, rows) => {
            if (err) return reject(err)
            resolve(rows)
        })
    })

const openai = new OpenAI({ apiKey: process.env.OPENAI_AI_LISTER_API_KEY })

const STORE_ID = 1

async function generateFilterValues(product, filterGroups) {
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
                Here are the filter groups: ${JSON.stringify(filterGroups)}
                `,
    })

    try {
        return JSON.parse(response.output_text)
    } catch (err) {
        console.error(`  Failed to parse AI response for product ${product.id}:`, response.output_text)
        return null
    }
}

async function main() {
    const productIds = [
        190743248921, 191083741209, 6047583699133, 6047588417725, 6047589630141, 6047590318269, 6047591694525,
        7533789315261, 8310368075965, 8310370959549, 8310371516605, 8310372565181, 8310932046013, 8310932177085,
        8310932340925, 8310932373693, 8310932439229, 8310932570301,
    ]

    if (productIds.length === 0) {
        console.error('Usage: node runAIFilterGen.js <product_id> [product_id...]')
        process.exit(1)
    }

    console.log(`Processing ${productIds.length} product(s): ${productIds.join(', ')}`)

    // Get product details
    const products = await query(
        `SELECT p.id, p.title, p.body_html, p.product_type, p.vendor, vn.sku
         FROM products p
         LEFT JOIN variants_new vn ON vn.product_id = p.id
         WHERE p.id IN (?)`,
        [productIds]
    )

    if (products.length === 0) {
        console.error('No products found for the given IDs.')
        process.exit(1)
    }

    // Group products by product_type
    const productsByType = {}
    for (const p of products) {
        const type = p.product_type || 'Unknown'
        if (!productsByType[type]) productsByType[type] = []
        productsByType[type].push(p)
    }

    console.log(`\nFound ${Object.keys(productsByType).length} product type(s):`)
    Object.entries(productsByType).forEach(([type, prods]) => console.log(`  - "${type}" (${prods.length} products)`))

    // For each product type, get the filter groups directly by product_type
    for (const [productType, typeProducts] of Object.entries(productsByType)) {
        const filterGroups = await query(
            `SELECT DISTINCT fg.id, fg.name, fg.type, fg.unit
             FROM product_filter_values_new pfv
             JOIN filter_groups fg ON fg.id = pfv.filter_group_id
             JOIN products p ON p.id = pfv.product_id
             WHERE p.product_type = ?`,
            [productType]
        )

        if (filterGroups.length === 0) {
            console.log(`\n  Product type "${productType}" has no existing filter groups — skipping.`)
            continue
        }

        // Build filter groups with existing values (like the AI lister does)
        const filterGroupsWithValues = []
        for (const fg of filterGroups) {
            const existingValues = await query(
                `SELECT DISTINCT pfv.value 
                 FROM product_filter_values_new pfv
                 JOIN products p ON p.id = pfv.product_id
                 WHERE pfv.filter_group_id = ? AND p.product_type = ?
                 LIMIT 50`,
                [fg.id, productType]
            )
            filterGroupsWithValues.push({
                name: fg.name,
                type: fg.type,
                unit: fg.unit || '',
                previousValues: existingValues.map((r) => r.value),
            })
        }

        console.log(`\n  Product type "${productType}" — ${filterGroups.length} filter group(s):`)
        filterGroups.forEach((fg) => console.log(`    - ${fg.name} (${fg.type}${fg.unit ? ', ' + fg.unit : ''})`))

        console.log(`\n  Generating filter values for ${typeProducts.length} product(s)...`)

        const fgIds = filterGroups.map((fg) => fg.id)

        // Build a filter group name -> id map
        const filterGroupIdMap = {}
        for (const fg of filterGroups) {
            filterGroupIdMap[fg.name] = fg.id
        }

        for (const product of typeProducts) {
            console.log(`\n    Processing: ${product.title} (${product.id})`)

            const productPayload = {
                id: product.id,
                title: product.title,
                custom_specifications: product.body_html
                    ? product.body_html.replace(/<[^>]*>/g, '').substring(0, 2000)
                    : null,
                custom_features: null,
            }

            const filterValues = await generateFilterValues(productPayload, filterGroupsWithValues)
            if (!filterValues) {
                console.log(`      Skipped — no values returned`)
                continue
            }

            // Only clear existing values after we successfully got new ones
            if (fgIds.length > 0) {
                await query(`DELETE FROM product_filter_values_new WHERE product_id = ? AND filter_group_id IN (?)`, [
                    product.id,
                    fgIds,
                ])
            }

            let insertCount = 0
            for (const fv of filterValues) {
                const fgId = filterGroupIdMap[fv.filterGroup]
                if (!fgId) {
                    console.error(`      Filter group not found: ${fv.filterGroup}`)
                    continue
                }
                await query(
                    `INSERT IGNORE INTO product_filter_values_new (product_id, filter_group_id, value, store_id) VALUES (?, ?, ?, ?)`,
                    [product.id, fgId, fv.filterValue, STORE_ID]
                )
                insertCount++
            }
            console.log(`      Inserted ${insertCount} filter value(s)`)
        }
    }

    console.log('\nDone!')
    pool.end()
}

main().catch((err) => {
    console.error('Fatal error:', err)
    pool.end()
    process.exit(1)
})
