import fetch from 'node-fetch'
import fs from 'fs'

const BASE_URL = 'https://mechmaxx.com/collections/all/products.json'
const TOTAL_PAGES = 7
const OUTPUT_FILE = 'mechmaxx_products.csv'

function escapeCsv(val) {
    if (val == null) return ''
    const str = String(val)
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"'
    }
    return str
}

function rowToCsv(fields) {
    return fields.map(escapeCsv).join(',')
}

async function fetchPage(page) {
    const url = `${BASE_URL}?limit=250&page=${page}`
    console.log(`Fetching page ${page}...`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`)
    const data = await res.json()
    return data.products || []
}

async function main() {
    const headers = [
        'id',
        'title',
        'handle',
        'vendor',
        'product_type',
        'tags',
        'published_at',
        'created_at',
        'updated_at',
        'sku',
        'price',
        'compare_at_price',
        'available',
        'grams',
        'image_src',
    ]

    const rows = [rowToCsv(headers)]

    for (let page = 1; page <= TOTAL_PAGES; page++) {
        const products = await fetchPage(page)
        if (!products.length) {
            console.log(`No products on page ${page}, stopping.`)
            break
        }

        for (const product of products) {
            const variant = product.variants?.[0] ?? {}
            const image = product.images?.[0] ?? {}
            const row = [
                product.id,
                product.title,
                product.handle,
                product.vendor,
                product.product_type,
                (product.tags ?? []).join(', '),
                product.published_at,
                product.created_at,
                product.updated_at,
                variant.sku,
                variant.price,
                variant.compare_at_price,
                variant.available,
                variant.grams,
                image.src,
            ]
            rows.push(rowToCsv(row))
        }

        console.log(`  → ${products.length} products collected from page ${page}`)
    }

    fs.writeFileSync(OUTPUT_FILE, rows.join('\n'), 'utf8')
    console.log(`\nSaved ${rows.length - 1} products to ${OUTPUT_FILE}`)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
