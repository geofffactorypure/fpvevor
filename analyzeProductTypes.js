/**
 * Analyze Vevor product categorization using OpenAI.
 *
 * For each product, asks if the product_type needs review.
 * Products that need review are appended to needs_review.txt.
 *
 * Usage:
 *   node analyzeProductTypes.js
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fs from 'fs'
import mysql from 'mysql'
import OpenAI from 'openai'

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

const STORE_ID = 1
const OUTPUT_FILE = './needs_review.txt'

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

async function needsReview(product) {
    const response = await openai.chat.completions.create({
        model: 'gpt-5.4-mini',
        messages: [
            {
                role: 'system',
                content: `Does this product's type match its title? Answer only "yes" or "no". "yes" means it matches, "no" means it looks wrong.`,
            },
            {
                role: 'user',
                content: `Title: ${product.title}\nProduct Type: ${product.product_type}`,
            },
        ],
    })

    const answer = response.choices[0].message.content.trim().toLowerCase()
    return answer.startsWith('no')
}

async function main() {
    try {
        console.log(`\n═══ Analyze Vevor Product Categorization ═══\n`)

        const products = await query(
            `SELECT id, title, product_type
             FROM products
             WHERE vendor = 'Vevor'
               AND store_id = ?
               AND product_type IS NOT NULL
               AND product_type != ''`,
            [STORE_ID]
        )

        console.log(`Found ${products.length} Vevor product(s) to check\n`)

        if (products.length === 0) {
            console.log('Nothing to analyze. Exiting.')
            return
        }

        let flagged = 0

        for (let i = 0; i < products.length; i++) {
            const product = products[i]
            const bad = await needsReview(product)

            if (bad) {
                flagged++
                const line = `${product.id}\t${product.product_type}\t${product.title}\n`
                fs.appendFileSync(OUTPUT_FILE, line)
                console.log(`  ⚠ [${product.id}] "${product.title}" (type: ${product.product_type})`)
            }

            if ((i + 1) % 50 === 0 || i === products.length - 1) {
                const pct = (((i + 1) / products.length) * 100).toFixed(1)
                console.log(`  Progress: ${i + 1}/${products.length} (${pct}%) — ${flagged} flagged`)
            }
        }

        console.log(`\n═══ Done ═══`)
        console.log(`Checked: ${products.length}`)
        console.log(`Flagged for review: ${flagged}`)
        if (flagged > 0) console.log(`Written to: ${OUTPUT_FILE}`)
    } finally {
        pool.end()
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
