import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import mysql from 'mysql'

const SHOPIFY_API_VERSION = '2026-01'
const STORE_ID = 1

function createPool() {
    return mysql.createPool({
        connectionLimit: 2,
        host: process.env.DB_WRITE_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
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

async function main() {
    const pool = createPool()
    const rows = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
    if (!rows.length) throw new Error(`Store ${STORE_ID} not found`)
    const storeInfo = rows[0]
    console.log(`Using store: ${storeInfo.shopify_name}`)

    // Step 1: Create product with productOptions (this auto-creates variants for each option value)
    console.log('\n── Step 1: Create product with productOptions ──')
    const createResult = await shopifyGraphQL(
        storeInfo,
        `
        mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
            productCreate(product: $product, media: $media) {
                product {
                    id
                    title
                    options {
                        id
                        name
                        optionValues {
                            id
                            name
                        }
                    }
                    variants(first: 10) {
                        nodes {
                            id
                            title
                            sku
                            price
                            selectedOptions {
                                name
                                value
                            }
                        }
                    }
                }
                userErrors {
                    field
                    message
                }
            }
        }
        `,
        {
            product: {
                title: 'TEST - Costway Variant Product (DELETE ME)',
                descriptionHtml: '<p>Test product to verify variant creation with productOptions.</p>',
                productType: 'Test Products',
                vendor: 'Costway',
                status: 'DRAFT',
                tags: ['test', 'delete-me'],
                productOptions: [
                    {
                        name: 'Color',
                        values: [
                            { name: 'Blue' },
                            { name: 'Red' },
                            { name: 'Black' },
                        ],
                    },
                ],
            },
        }
    )

    if (createResult.errors) {
        console.error('GraphQL errors:', JSON.stringify(createResult.errors, null, 2))
        pool.end()
        return
    }
    if (createResult.data?.productCreate?.userErrors?.length > 0) {
        console.error('User errors:', JSON.stringify(createResult.data.productCreate.userErrors, null, 2))
        pool.end()
        return
    }

    const product = createResult.data.productCreate.product
    console.log(`✓ Product created: ${product.id}`)
    console.log(`  Title: ${product.title}`)
    console.log(`  Options:`)
    for (const opt of product.options) {
        console.log(`    ${opt.name}: ${opt.optionValues.map((v) => v.name).join(', ')}`)
    }
    console.log(`  Auto-created variants:`)
    for (const v of product.variants.nodes) {
        const opts = v.selectedOptions.map((o) => `${o.name}=${o.value}`).join(', ')
        console.log(`    ${v.title} | SKU: ${v.sku || '(none)'} | Price: $${v.price} | ${opts}`)
    }

    // Step 2: Create the missing variants + update all with SKU/price/cost
    console.log('\n── Step 2: Create missing variants + set SKU/price ──')
    const variantData = [
        { color: 'Blue', sku: 'TEST-CW-BLUE', price: '49.99', cost: '25.00' },
        { color: 'Red', sku: 'TEST-CW-RED', price: '52.99', cost: '26.00' },
        { color: 'Black', sku: 'TEST-CW-BLACK', price: '49.99', cost: '25.00' },
    ]

    // Find which variants already exist
    const existingColors = product.variants.nodes.map(
        (v) => v.selectedOptions.find((o) => o.name === 'Color')?.value
    )
    const missingVariants = variantData.filter((d) => !existingColors.includes(d.color))
    const existingVariants = variantData.filter((d) => existingColors.includes(d.color))

    // Build option value ID map from productOptions
    const colorOption = product.options.find((o) => o.name === 'Color')
    const optionValueMap = {}
    for (const ov of colorOption.optionValues) {
        optionValueMap[ov.name] = ov.id
    }

    // Create missing variants
    if (missingVariants.length > 0) {
        console.log(`  Creating ${missingVariants.length} new variants...`)
        const createVariantsResult = await shopifyGraphQL(
            storeInfo,
            `
            mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                productVariantsBulkCreate(productId: $productId, variants: $variants) {
                    productVariants {
                        id
                        title
                        sku
                        price
                        selectedOptions { name value }
                    }
                    userErrors { field message }
                }
            }
            `,
            {
                productId: product.id,
                variants: missingVariants.map((d) => ({
                    optionValues: [{ optionId: colorOption.id, name: d.color }],
                    price: d.price,
                    inventoryItem: { sku: d.sku, cost: d.cost, tracked: false },
                })),
            }
        )

        if (createVariantsResult.errors) {
            console.error('Create variants errors:', JSON.stringify(createVariantsResult.errors, null, 2))
        } else if (createVariantsResult.data?.productVariantsBulkCreate?.userErrors?.length > 0) {
            console.error('Create variants user errors:', JSON.stringify(createVariantsResult.data.productVariantsBulkCreate.userErrors, null, 2))
        } else {
            console.log(`  ✓ Created variants:`)
            for (const v of createVariantsResult.data.productVariantsBulkCreate.productVariants) {
                const opts = v.selectedOptions.map((o) => `${o.name}=${o.value}`).join(', ')
                console.log(`    ${v.title} | SKU: ${v.sku} | Price: $${v.price} | ${opts}`)
            }
        }
    }

    // Update existing variants (the auto-created one)
    if (existingVariants.length > 0) {
        console.log(`  Updating ${existingVariants.length} existing variants...`)
        const variantsInput = product.variants.nodes.map((v) => {
            const colorValue = v.selectedOptions.find((o) => o.name === 'Color')?.value
            const data = variantData.find((d) => d.color === colorValue)
            return {
                id: v.id,
                price: data.price,
                inventoryItem: { sku: data.sku, cost: data.cost, tracked: false },
            }
        })

        const updateResult = await shopifyGraphQL(
            storeInfo,
            `
            mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                    product {
                        id
                        variants(first: 10) {
                            nodes {
                                id title sku price
                                selectedOptions { name value }
                            }
                        }
                    }
                    userErrors { field message }
                }
            }
            `,
            {
                productId: product.id,
                variants: variantsInput,
            }
        )

        if (updateResult.errors) {
            console.error('Update errors:', JSON.stringify(updateResult.errors, null, 2))
        } else if (updateResult.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
            console.error('Update user errors:', JSON.stringify(updateResult.data.productVariantsBulkUpdate.userErrors, null, 2))
        } else {
            console.log(`  ✓ Updated existing variant`)
        }
    }

    // Final state
    console.log('\n── Final product state ──')
    const finalResult = await shopifyGraphQL(
        storeInfo,
        `
        query getProduct($id: ID!) {
            product(id: $id) {
                id title
                options { name optionValues { name } }
                variants(first: 10) {
                    nodes {
                        id title sku price
                        selectedOptions { name value }
                    }
                }
            }
        }
        `,
        { id: product.id }
    )
    const final = finalResult.data.product
    console.log(`Product: ${final.title}`)
    console.log(`Options: ${final.options.map((o) => `${o.name}(${o.optionValues.map((v) => v.name).join(',')})`).join(' | ')}`)
    console.log(`Variants:`)
    for (const v of final.variants.nodes) {
        const opts = v.selectedOptions.map((o) => `${o.name}=${o.value}`).join(', ')
        console.log(`  ${v.title} | SKU: ${v.sku} | Price: $${v.price} | ${opts}`)
    }

    console.log(`\n── Done! Product ID: ${product.id} ──`)
    console.log('(Remember to delete this test product)')
    pool.end()
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
