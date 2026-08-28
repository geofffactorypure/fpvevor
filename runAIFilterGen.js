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
        8429076119741, 8429076152509, 8429077627069, 8429077659837, 8429077823677, 8429078872253, 8429079396541,
        8429079527613, 8429080084669, 8429080150205, 8429080281277, 8429080379581, 8429080838333, 8429080936637,
        8429081002173, 8429081166013, 8429081198781, 8429081821373, 8429081854141, 8476220096701, 8476220129469,
        8476220162237, 8476220522685, 8476220620989, 8476220719293, 8476220752061, 8476220883133, 8476221112509,
        8476221145277, 8476221178045, 8476221243581, 8476221276349, 8476221309117, 8476221538493, 8476221604029,
        8476221702333, 8476221735101, 8476221866173, 8476221964477, 8476222062781, 8476222095549, 8476222128317,
        8476222161085, 8476222521533, 8476222652605, 8476222980285, 8476223045821, 8476223602877, 8476223733949,
        8476224159933, 8476224192701, 8476224258237, 8476224291005, 8476224422077, 8476224520381, 8476224553149,
        8476224618685, 8476224684221, 8476224749757, 8476225142973, 8476225306813, 8476225568957, 8476225634493,
        8476225700029, 8476225765565, 8476226060477, 8476226093245, 8476226126013, 8476226191549, 8476226257085,
        8476226289853, 8476226388157, 8476226453693, 8476226551997, 8476227403965, 8476227698877, 8476227928253,
        8476227993789, 8476228387005, 8476228419773, 8476229370045, 8476229435581, 8476229566653, 8476229697725,
        8476230123709, 8476230320317, 8476230385853, 8476230877373, 8476230942909, 8476230975677, 8476231008445,
        8476231041213, 8476231139517, 8476231205053, 8476232253629, 8476232286397, 8476232417469, 8476232515773,
        8476232581309, 8476232614077, 8476232646845, 8476233138365, 8476233171133, 8476233203901, 8476233236669,
        8476233302205, 8476233367741, 8476233433277, 8476233466045, 8476233498813, 8476233629885, 8476233695421,
        8476233760957, 8476233793725, 8476233826493, 8476233892029, 8476234383549, 8476235137213, 8476236513469,
        8476236546237, 8476236644541, 8476236873917, 8476237037757, 8476237070525, 8476237136061, 8476237168829,
        8476237201597, 8476237234365,
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
