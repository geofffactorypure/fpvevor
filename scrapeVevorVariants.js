import fetch from 'node-fetch'

/**
 * Scrapes variant/option data from a Vevor product page.
 * Extracts: window.PRODUCT_DATA, window.DETAIL_ATTR_LIST, window.DETAIL_ATTR_LINK
 *
 * Usage: node --input-type=module scripts/scrapeVevorVariants.js <url>
 */

const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
}

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
    } else if (firstChar === '"') {
        // Base64-encoded string value like PRODUCT_DATA_PRICE
        const end = html.indexOf('";', jsonStart)
        if (end !== -1) return html.substring(jsonStart + 1, end)
    }
    return null
}

export async function scrapeVevorVariants(productUrl) {
    const res = await fetch(productUrl, {
        headers: HEADERS,
        signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`Failed to fetch ${productUrl}: ${res.status}`)
    const html = await res.text()

    const productData = extractWindowJSON(html, 'PRODUCT_DATA')
    const attrList = extractWindowJSON(html, 'DETAIL_ATTR_LIST')
    const attrLink = extractWindowJSON(html, 'DETAIL_ATTR_LINK')

    if (!attrList) throw new Error('DETAIL_ATTR_LIST not found in page HTML')

    // Build a clean structured output
    const groups = Object.entries(attrList).map(([groupName, group]) => ({
        name: group.attrName || groupName,
        showImg: group.showImg || false,
        options: Object.values(group.list).map((opt) => ({
            value: opt.value,
            selected: !!opt.selected,
            prime: opt.prime,
            sku: opt.goodSn,
            url: opt.url,
            imgUrl: opt.imgUrl,
        })),
    }))

    // Resolve each variant link to its option combination using prime factorization
    const allPrimes = {}
    for (const group of groups) {
        for (const opt of group.options) {
            allPrimes[opt.prime] = { group: group.name, value: opt.value }
        }
    }

    const variants = (attrLink || []).map((link) => {
        // Factor the prime product to find which options make this variant
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
            webGoodSn: link.webGoodSn,
            canBuy: !!link.canBuy,
            prime: link.prime,
            options,
        }
    })

    return {
        title: productData?.title || null,
        currentSku: productData?.goodsSn || null,
        currentAttrs: productData?.attr || null,
        stock: productData?.stock ?? null,
        groups,
        variants,
    }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const url = process.argv[2]
if (!url) {
    console.error('Usage: node --input-type=module scripts/scrapeVevorVariants.js <vevor-product-url>')
    process.exit(1)
}

const result = await scrapeVevorVariants(url)

console.log('\n═══ OPTION GROUPS ═══')
for (const group of result.groups) {
    console.log(`\n┌─ ${group.name} ${group.showImg ? '(has images)' : ''}`)
    for (const opt of group.options) {
        const sel = opt.selected ? ' ← selected' : ''
        console.log(`│  ${opt.value} | SKU: ${opt.sku} | prime: ${opt.prime}${sel}`)
        console.log(`│    ${opt.url}`)
    }
    console.log('└─')
}

console.log('\n═══ ALL VARIANTS ═══')
console.log(`Total: ${result.variants.length}\n`)
for (const v of result.variants) {
    const opts = Object.entries(v.options)
        .map(([k, val]) => `${k}: ${val}`)
        .join(' | ')
    console.log(`SKU: ${v.sku} ${v.canBuy ? '✓' : '✗ OOS'}`)
    console.log(`  ${opts}`)
    console.log(`  ${v.url}`)
    console.log()
}
