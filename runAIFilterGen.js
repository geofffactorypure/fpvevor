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
    const filterGroupDescriptions = filterGroups
        .map((fg) => {
            if (fg.type === 'range') {
                return `- "${fg.name}" (type: range, unit: ${fg.unit}) — provide a numeric value`
            }
            return `- "${fg.name}" (type: checkbox) — provide applicable value(s) as a string or array of strings`
        })
        .join('\n')

    const prompt = `Given the following product, determine the appropriate filter values for each filter group.

Product:
- ID: ${product.id}
- Title: ${product.title}
- SKU: ${product.sku || 'N/A'}
- Description: ${product.body_html ? product.body_html.replace(/<[^>]*>/g, '').substring(0, 2000) : 'N/A'}
- Product Type: ${product.product_type || 'N/A'}
- Vendor: ${product.vendor || 'N/A'}

Filter Groups to populate:
${filterGroupDescriptions}

Return a JSON object where each key is the exact filter group name and the value is either:
- A single value (string or number) for the filter
- An array of values if multiple apply (for checkbox types)
- null if the filter doesn't apply to this product

Only return the JSON object, no markdown or other text.`

    const response = await openai.responses.create({
        model: 'gpt-5.4',
        tools: [{ type: 'web_search' }],
        input: prompt,
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
        8309682602173, 8309682634941, 8309682667709, 8309682700477, 8309682733245, 8309682766013, 8309682831549,
        8309682864317, 8309682897085, 8309682929853, 8309682995389, 8309683028157, 8309683060925, 8309683093693,
        8309683126461, 8309683159229, 8309683191997, 8309683224765, 8309683257533, 8309683290301, 8309693776061,
        8309693808829, 8309693841597, 8309693874365, 8309693907133, 8309693972669, 8309694005437, 8309694038205,
        8309694070973, 8309694103741, 8309694136509, 8309694169277, 8309694202045,
    ]

    if (productIds.length === 0) {
        console.error('Usage: node runAIFilterGen.js <product_id> [product_id...]')
        process.exit(1)
    }

    console.log(`Processing ${productIds.length} product(s): ${productIds.join(', ')}`)

    // Find collections for these products
    const collections = await query(
        `SELECT DISTINCT pc.collection_id, c.title
         FROM product_collections pc
         JOIN collections c ON c.id = pc.collection_id
         WHERE pc.product_id IN (?)`,
        [productIds]
    )

    if (collections.length === 0) {
        console.error('No collections found for the given product IDs.')
        process.exit(1)
    }

    console.log(`\nFound ${collections.length} collection(s):`)
    collections.forEach((c) => console.log(`  - [${c.collection_id}] ${c.title}`))

    // For each collection, get the filter groups that already have values for products in that collection
    for (const collection of collections) {
        const filterGroups = await query(
            `SELECT DISTINCT fg.id, fg.name, fg.type, fg.unit
             FROM filter_groups fg
             WHERE fg.id IN (
                 SELECT filter_group_id
                 FROM product_filter_values_new
                 WHERE product_id IN (
                     SELECT product_id
                     FROM product_collections
                     WHERE collection_id = ?
                 )
             )`,
            [collection.collection_id]
        )

        if (filterGroups.length === 0) {
            console.log(`\n  Collection "${collection.title}" has no existing filter groups — skipping.`)
            continue
        }

        console.log(`\n  Collection "${collection.title}" — ${filterGroups.length} filter group(s):`)
        filterGroups.forEach((fg) => console.log(`    - ${fg.name} (${fg.type}${fg.unit ? ', ' + fg.unit : ''})`))

        // Get product details for the products in this collection
        const products = await query(
            `SELECT p.id, p.title, p.body_html, p.product_type, p.vendor, vn.sku
             FROM products p
             LEFT JOIN variants_new vn ON vn.product_id = p.id
             WHERE p.id IN (?)`,
            [productIds]
        )

        const collectionProductIds = await query(
            `SELECT product_id FROM product_collections WHERE collection_id = ? AND product_id IN (?)`,
            [collection.collection_id, productIds]
        )
        const collectionProductIdSet = new Set(collectionProductIds.map((r) => r.product_id))
        const filteredProducts = products.filter((p) => collectionProductIdSet.has(p.id))

        console.log(`\n  Generating filter values for ${filteredProducts.length} product(s)...`)

        // Delete existing filter values for these products in this collection's filter groups so we can redo
        const fgIds = filterGroups.map((fg) => fg.id)
        const filteredProductIds = filteredProducts.map((p) => p.id)
        if (fgIds.length > 0 && filteredProductIds.length > 0) {
            await query(`DELETE FROM product_filter_values_new WHERE product_id IN (?) AND filter_group_id IN (?)`, [
                filteredProductIds,
                fgIds,
            ])
            console.log(`    Cleared existing filter values for ${filteredProductIds.length} product(s)`)
        }

        for (const product of filteredProducts) {
            console.log(`\n    Processing: ${product.title} (${product.id})`)

            const filterValues = await generateFilterValues(product, filterGroups)
            if (!filterValues) {
                console.log(`      Skipped — no values returned`)
                continue
            }

            let insertCount = 0
            for (const fg of filterGroups) {
                const value = filterValues[fg.name]
                if (value == null) continue

                const values = Array.isArray(value) ? value : [value]
                for (const v of values) {
                    const stringValue = String(v)
                    if (!stringValue) continue

                    await query(
                        `INSERT IGNORE INTO product_filter_values_new (product_id, filter_group_id, value, store_id) VALUES (?, ?, ?, ?)`,
                        [product.id, fg.id, stringValue, STORE_ID]
                    )
                    insertCount++
                }
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
