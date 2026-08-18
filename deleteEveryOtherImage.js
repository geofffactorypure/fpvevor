import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'
import mysql from 'mysql'

/**
 * Delete Every Other Image Script
 *
 * For each product ID in PRODUCT_IDS below, fetches all images and deletes
 * every other one (index 1, 3, 5, … — i.e. the duplicates added by the lister).
 *
 * Usage: node deleteEveryOtherImage.js
 */

// ── Config ───────────────────────────────────────────────────────────────────
const STORE_ID = 1
const SHOPIFY_API_VERSION = '2025-01'
const CONCURRENCY = 5
const DRY_RUN = false // set true to preview without deleting

// ── Product IDs to process ────────────────────────────────────────────────────
const PRODUCT_IDS = [
    {
        id: 8366957297853,
    },
    {
        id: 8366957428925,
    },
    {
        id: 8366957592765,
    },
    {
        id: 8366957723837,
    },
    {
        id: 8366957822141,
    },
    {
        id: 8366957887677,
    },
    {
        id: 8366957920445,
    },
    {
        id: 8366958018749,
    },
    {
        id: 8366958117053,
    },
    {
        id: 8366958313661,
    },
    {
        id: 8366958477501,
    },
    {
        id: 8366958608573,
    },
    {
        id: 8366958739645,
    },
    {
        id: 8366958837949,
    },
    {
        id: 8366958969021,
    },
    {
        id: 8366959100093,
    },
    {
        id: 8366959132861,
    },
    {
        id: 8366959329469,
    },
    {
        id: 8366959689917,
    },
    {
        id: 8366959788221,
    },
    {
        id: 8366959919293,
    },
    {
        id: 8366960148669,
    },
    {
        id: 8366960214205,
    },
    {
        id: 8366960541885,
    },
    {
        id: 8366960607421,
    },
    {
        id: 8366960672957,
    },
    {
        id: 8366961000637,
    },
    {
        id: 8366961262781,
    },
    {
        id: 8366961393853,
    },
    {
        id: 8366961459389,
    },
    {
        id: 8366961590461,
    },
    {
        id: 8366961787069,
    },
    {
        id: 8366961950909,
    },
    {
        id: 8366962081981,
    },
    {
        id: 8366962278589,
    },
    {
        id: 8366962311357,
    },
    {
        id: 8366962442429,
    },
    {
        id: 8366962507965,
    },
    {
        id: 8366962671805,
    },
    {
        id: 8366962835645,
    },
    {
        id: 8366962901181,
    },
    {
        id: 8366962999485,
    },
    {
        id: 8366963130557,
    },
    {
        id: 8366963261629,
    },
    {
        id: 8366963392701,
    },
    {
        id: 8366963491005,
    },
    {
        id: 8366963589309,
    },
    {
        id: 8366963687613,
    },
    {
        id: 8366963851453,
    },
    {
        id: 8366963949757,
    },
    {
        id: 8366964211901,
    },
    {
        id: 8366964342973,
    },
    {
        id: 8366964441277,
    },
    {
        id: 8366964605117,
    },
    {
        id: 8366964768957,
    },
    {
        id: 8366964998333,
    },
    {
        id: 8366965031101,
    },
    {
        id: 8366965129405,
    },
    {
        id: 8366965194941,
    },
    {
        id: 8366965391549,
    },
    {
        id: 8366965588157,
    },
    {
        id: 8366965784765,
    },
    {
        id: 8366965817533,
    },
    {
        id: 8366965915837,
    },
    {
        id: 8366966014141,
    },
    {
        id: 8366966145213,
    },
    {
        id: 8366966341821,
    },
    {
        id: 8366966440125,
    },
    {
        id: 8366966669501,
    },
    {
        id: 8366966702269,
    },
    {
        id: 8366966866109,
    },
    {
        id: 8366967029949,
    },
    {
        id: 8366967161021,
    },
    {
        id: 8366967292093,
    },
    {
        id: 8366967390397,
    },
    {
        id: 8366967521469,
    },
    {
        id: 8366967849149,
    },
    {
        id: 8366968078525,
    },
    {
        id: 8366968144061,
    },
    {
        id: 8366968242365,
    },
    {
        id: 8366968406205,
    },
    {
        id: 8366968537277,
    },
    {
        id: 8366968733885,
    },
    {
        id: 8366968799421,
    },
    {
        id: 8366968930493,
    },
    {
        id: 8366969061565,
    },
    {
        id: 8366969127101,
    },
    {
        id: 8366969192637,
    },
    {
        id: 8366969258173,
    },
    {
        id: 8366969323709,
    },
    {
        id: 8366969585853,
    },
    {
        id: 8366969684157,
    },
    {
        id: 8366969815229,
    },
    {
        id: 8366969946301,
    },
    {
        id: 8366970110141,
    },
    {
        id: 8366970208445,
    },
    {
        id: 8366970339517,
    },
    {
        id: 8366970405053,
    },
    {
        id: 8366970568893,
    },
    {
        id: 8366970634429,
    },
    {
        id: 8366970732733,
    },
    {
        id: 8366970765501,
    },
    {
        id: 8366970831037,
    },
    {
        id: 8366970929341,
    },
    {
        id: 8366971027645,
    },
    {
        id: 8366971093181,
    },
    {
        id: 8366971224253,
    },
    {
        id: 8366971257021,
    },
    {
        id: 8366971388093,
    },
    {
        id: 8366971617469,
    },
    {
        id: 8366971781309,
    },
    {
        id: 8366972305597,
    },
    {
        id: 8366972666045,
    },
    {
        id: 8366972993725,
    },
    {
        id: 8366973386941,
    },
    {
        id: 8366973616317,
    },
    {
        id: 8366973812925,
    },
    {
        id: 8366973943997,
    },
    {
        id: 8366974173373,
    },
    {
        id: 8366974763197,
    },
    {
        id: 8366975090877,
    },
    {
        id: 8366975385789,
    },
    {
        id: 8366975680701,
    },
    {
        id: 8366975877309,
    },
    {
        id: 8366976073917,
    },
    {
        id: 8366976303293,
    },
    {
        id: 8366976434365,
    },
    {
        id: 8366976630973,
    },
    {
        id: 8366977024189,
    },
    {
        id: 8366977581245,
    },
    {
        id: 8366977843389,
    },
    {
        id: 8366978171069,
    },
    {
        id: 8366978367677,
    },
    {
        id: 8366978400445,
    },
    {
        id: 8366978564285,
    },
    {
        id: 8366979023037,
    },
    {
        id: 8366979383485,
    },
    {
        id: 8366979678397,
    },
    {
        id: 8366979940541,
    },
    {
        id: 8366980202685,
    },
    {
        id: 8366980366525,
    },
    {
        id: 8366980595901,
    },
    {
        id: 8366980825277,
    },
    {
        id: 8366981087421,
    },
    {
        id: 8366981415101,
    },
    {
        id: 8366981677245,
    },
    {
        id: 8366981906621,
    },
    {
        id: 8366982103229,
    },
    {
        id: 8366982332605,
    },
    {
        id: 8366982758589,
    },
    {
        id: 8366982856893,
    },
    {
        id: 8366982955197,
    },
    {
        id: 8366983119037,
    },
    {
        id: 8366983512253,
    },
    {
        id: 8366983676093,
    },
    {
        id: 8366983807165,
    },
    {
        id: 8366984003773,
    },
    {
        id: 8366984069309,
    },
    {
        id: 8366984265917,
    },
    {
        id: 8366984528061,
    },
    {
        id: 8366984790205,
    },
    {
        id: 8366985478333,
    },
    {
        id: 8366985806013,
    },
    {
        id: 8366985969853,
    },
    {
        id: 8366986297533,
    },
    {
        id: 8366986789053,
    },
    {
        id: 8366987182269,
    },
    {
        id: 8366987280573,
    },
    {
        id: 8366987444413,
    },
    {
        id: 8366987837629,
    },
    {
        id: 8366988165309,
    },
    {
        id: 8366988492989,
    },
    {
        id: 8366988591293,
    },
    {
        id: 8366989050045,
    },
    {
        id: 8366989148349,
    },
    {
        id: 8366989443261,
    },
    {
        id: 8366989869245,
    },
    {
        id: 8366990327997,
    },
    {
        id: 8366990885053,
    },
    {
        id: 8366991409341,
    },
    {
        id: 8366991868093,
    },
    {
        id: 8366992294077,
    },
    {
        id: 8366992523453,
    },
    {
        id: 8366993014973,
    },
    {
        id: 8366993408189,
    },
    {
        id: 8366993735869,
    },
    {
        id: 8366993998013,
    },
    {
        id: 8366994653373,
    },
    {
        id: 8366995538109,
    },
    {
        id: 8366996324541,
    },
    {
        id: 8366997373117,
    },
    {
        id: 8366998061245,
    },
    {
        id: 8366998651069,
    },
    {
        id: 8366999240893,
    },
    {
        id: 8367000322237,
    },
    {
        id: 8367000682685,
    },
    {
        id: 8367000944829,
    },
    {
        id: 8367001403581,
    },
    {
        id: 8367001993405,
    },
    {
        id: 8367002255549,
    },
    {
        id: 8367002419389,
    },
    {
        id: 8367002845373,
    },
    {
        id: 8367003304125,
    },
    {
        id: 8367003795645,
    },
    {
        id: 8367003992253,
    },
    {
        id: 8367004156093,
    },
    {
        id: 8367004319933,
    },
    {
        id: 8367004811453,
    },
    {
        id: 8367005991101,
    },
    {
        id: 8367007465661,
    },
    {
        id: 8367008383165,
    },
    {
        id: 8367009300669,
    },
    {
        id: 8367010185405,
    },
    {
        id: 8367010807997,
    },
    {
        id: 8367011659965,
    },
    {
        id: 8367012282557,
    },
    {
        id: 8367012610237,
    },
    {
        id: 8367013036221,
    },
    {
        id: 8367013593277,
    },
    {
        id: 8367014150333,
    },
    {
        id: 8367014707389,
    },
    {
        id: 8367016444093,
    },
    {
        id: 8367018246333,
    },
    {
        id: 8367020048573,
    },
    {
        id: 8367021162685,
    },
    {
        id: 8367022473405,
    },
    {
        id: 8367023292605,
    },
    {
        id: 8367024013501,
    },
    {
        id: 8367024767165,
    },
    {
        id: 8367025455293,
    },
    {
        id: 8367025586365,
    },
    {
        id: 8367025750205,
    },
    {
        id: 8367025848509,
    },
    {
        id: 8367026372797,
    },
    {
        id: 8367027355837,
    },
    {
        id: 8367027847357,
    },
    {
        id: 8367028469949,
    },
    {
        id: 8367028895933,
    },
    {
        id: 8367029485757,
    },
    {
        id: 8367030042813,
    },
    {
        id: 8367030632637,
    },
    {
        id: 8367030894781,
    },
    {
        id: 8367031287997,
    },
    {
        id: 8367031681213,
    },
    {
        id: 8367032107197,
    },
    {
        id: 8367033254077,
    },
    {
        id: 8367034368189,
    },
    {
        id: 8367035285693,
    },
    {
        id: 8367035678909,
    },
    {
        id: 8367035809981,
    },
    {
        id: 8367036170429,
    },
    {
        id: 8367036760253,
    },
    {
        id: 8367038267581,
    },
    {
        id: 8367038955709,
    },
    {
        id: 8367039742141,
    },
    {
        id: 8367040495805,
    },
    {
        id: 8367040856253,
    },
    {
        id: 8367041511613,
    },
    {
        id: 8367041970365,
    },
    {
        id: 8367042396349,
    },
    {
        id: 8367042855101,
    },
    {
        id: 8367043510461,
    },
    {
        id: 8367043805373,
    },
    {
        id: 8367044133053,
    },
    {
        id: 8367045411005,
    },
    {
        id: 8367047082173,
    },
    {
        id: 8367048261821,
    },
    {
        id: 8367049277629,
    },
    {
        id: 8367050096829,
    },
    {
        id: 8367050588349,
    },
    {
        id: 8367051079869,
    },
    {
        id: 8367051374781,
    },
    {
        id: 8367052226749,
    },
    {
        id: 8367053406397,
    },
    {
        id: 8367054258365,
    },
    {
        id: 8367055405245,
    },
    {
        id: 8367056224445,
    },
    {
        id: 8367056486589,
    },
    {
        id: 8367056945341,
    },
    {
        id: 8367057371325,
    },
    {
        id: 8367057830077,
    },
    {
        id: 8367058124989,
    },
    {
        id: 8367058387133,
    },
    {
        id: 8367058452669,
    },
    {
        id: 8367058682045,
    },
    {
        id: 8367059927229,
    },
    {
        id: 8367060254909,
    },
    {
        id: 8367060418749,
    },
    {
        id: 8367060877501,
    },
    {
        id: 8367061237949,
    },
    {
        id: 8367061631165,
    },
    {
        id: 8367061926077,
    },
    {
        id: 8367062384829,
    },
    {
        id: 8367062876349,
    },
    {
        id: 8367063236797,
    },
    {
        id: 8367063498941,
    },
    {
        id: 8367063957693,
    },
    {
        id: 8367064088765,
    },
    {
        id: 8367064252605,
    },
    {
        id: 8367064613053,
    },
    {
        id: 8367064940733,
    },
    {
        id: 8367065235645,
    },
    {
        id: 8367065530557,
    },
    {
        id: 8367065956541,
    },
    {
        id: 8367066251453,
    },
    {
        id: 8367066677437,
    },
    {
        id: 8367066939581,
    },
    {
        id: 8367067300029,
    },
    {
        id: 8367067693245,
    },
    {
        id: 8367068053693,
    },
    {
        id: 8367068643517,
    },
    {
        id: 8367068872893,
    },
    {
        id: 8367069069501,
    },
    {
        id: 8367069495485,
    },
    {
        id: 8367069888701,
    },
    {
        id: 8367070183613,
    },
    {
        id: 8367070609597,
    },
    {
        id: 8367070937277,
    },
    {
        id: 8367071396029,
    },
    {
        id: 8367071658173,
    },
    {
        id: 8367072116925,
    },
    {
        id: 8367072608445,
    },
    {
        id: 8367073001661,
    },
    {
        id: 8367073296573,
    },
    {
        id: 8367130935485,
    },
    {
        id: 8367130968253,
    },
    {
        id: 8367132213437,
    },
    {
        id: 8367132606653,
    },
    {
        id: 8367132770493,
    },
    {
        id: 8367133130941,
    },
    {
        id: 8367133163709,
    },
    {
        id: 8367133360317,
    },
    {
        id: 8367133425853,
    },
    {
        id: 8368575840445,
    },
    {
        id: 8368575873213,
    },
    {
        id: 8368575905981,
    },
    {
        id: 8368575938749,
    },
    {
        id: 8368575971517,
    },
    {
        id: 8368576069821,
    },
    {
        id: 8368576299197,
    },
    {
        id: 8368576692413,
    },
].map((p) => p.id)

const { DB_PASSWORD, DB_WRITE_HOST, DB_USER } = process.env

// ── DB ────────────────────────────────────────────────────────────────────────
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

// ── Shopify GraphQL ───────────────────────────────────────────────────────────
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

// ── Fetch product images ──────────────────────────────────────────────────────
async function getProductImages(storeInfo, numericProductId) {
    const gid = `gid://shopify/Product/${numericProductId}`
    const GET_IMAGES = `
        query getImages($id: ID!) {
            product(id: $id) {
                id
                title
                media(first: 250) {
                    edges {
                        node {
                            id
                            mediaContentType
                        }
                    }
                }
            }
        }
    `
    const data = await shopifyGraphQL(storeInfo, GET_IMAGES, { id: gid })
    if (data.errors) throw new Error(JSON.stringify(data.errors))

    const product = data.data?.product
    if (!product) throw new Error(`Product ${numericProductId} not found`)

    const images = product.media.edges.filter((e) => e.node.mediaContentType === 'IMAGE').map((e) => e.node.id)

    return { title: product.title, images }
}

// ── Delete a single image ─────────────────────────────────────────────────────
async function deleteProductImage(storeInfo, productId, mediaId) {
    const DELETE_MEDIA = `
        mutation deleteMedia($productId: ID!, $mediaIds: [ID!]!) {
            productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
                deletedMediaIds
                userErrors {
                    field
                    message
                }
            }
        }
    `
    const data = await shopifyGraphQL(storeInfo, DELETE_MEDIA, {
        productId: `gid://shopify/Product/${productId}`,
        mediaIds: [mediaId],
    })

    if (data.errors) throw new Error(JSON.stringify(data.errors))
    const userErrors = data.data?.productDeleteMedia?.userErrors ?? []
    if (userErrors.length > 0) throw new Error(userErrors.map((e) => e.message).join(', '))

    return data.data?.productDeleteMedia?.deletedMediaIds ?? []
}

// ── Throttle helper ───────────────────────────────────────────────────────────
async function runConcurrent(tasks, concurrency) {
    const results = []
    let i = 0
    async function worker() {
        while (i < tasks.length) {
            const idx = i++
            results[idx] = await tasks[idx]()
        }
    }
    await Promise.all(Array.from({ length: concurrency }, worker))
    return results
}

// ── Process one product ───────────────────────────────────────────────────────
async function processProduct(storeInfo, numericId, dryRun) {
    console.log(`\n── Product ${numericId} ──`)

    let title, images
    try {
        ;({ title, images } = await getProductImages(storeInfo, numericId))
    } catch (err) {
        console.error(`  ERROR fetching images: ${err.message}`)
        return { id: numericId, deleted: 0, error: err.message }
    }

    console.log(`  Title : ${title}`)
    console.log(`  Images: ${images.length}`)

    if (images.length < 2) {
        console.log(`  Skipped — fewer than 2 images, nothing to delete`)
        return { id: numericId, deleted: 0 }
    }

    // Every other image starting at index 1 (0-based)
    const toDelete = images.filter((_, idx) => idx % 2 === 1)
    console.log(`  To delete: ${toDelete.length} image(s) (indices ${toDelete.map((_, i) => i * 2 + 1).join(', ')})`)

    if (dryRun) {
        console.log(`  DRY RUN — no deletions performed`)
        return { id: numericId, deleted: 0, dryRun: true }
    }

    let deleted = 0
    const tasks = toDelete.map((mediaId) => async () => {
        try {
            await deleteProductImage(storeInfo, numericId, mediaId)
            deleted++
            process.stdout.write('.')
        } catch (err) {
            process.stdout.write('X')
            console.error(`\n  ERROR deleting ${mediaId}: ${err.message}`)
        }
    })

    await runConcurrent(tasks, CONCURRENCY)
    console.log(`\n  Done — deleted ${deleted}/${toDelete.length}`)
    return { id: numericId, deleted }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const productIds = PRODUCT_IDS
    const dryRun = DRY_RUN

    if (productIds.length === 0) {
        console.error('No product IDs in PRODUCT_IDS array. Add them at the top of the script.')
        process.exit(1)
    }
    const pool = createPool()

    console.log(`\n${'═'.repeat(50)}`)
    console.log(`Delete Every Other Image`)
    console.log(`Products  : ${productIds.join(', ')}`)
    console.log(`Dry Run   : ${dryRun}`)
    console.log(`${'═'.repeat(50)}`)

    let storeInfo
    try {
        ;[storeInfo] = await query(pool, `SELECT * FROM stores WHERE id = ?`, [STORE_ID])
        if (!storeInfo) throw new Error(`Store ${STORE_ID} not found`)
    } catch (err) {
        console.error(`DB error: ${err.message}`)
        pool.end()
        process.exit(1)
    }

    const summary = []
    for (const id of productIds) {
        const result = await processProduct(storeInfo, id, dryRun)
        summary.push(result)
    }

    pool.end()

    console.log(`\n${'═'.repeat(50)}`)
    console.log(`Summary`)
    console.log(`${'═'.repeat(50)}`)
    let totalDeleted = 0
    for (const r of summary) {
        const status = r.error ? `ERROR: ${r.error}` : r.dryRun ? `dry-run` : `deleted ${r.deleted}`
        console.log(`  ${r.id}: ${status}`)
        totalDeleted += r.deleted ?? 0
    }
    console.log(`\nTotal images deleted: ${totalDeleted}`)
}

main().catch((err) => {
    console.error('Fatal:', err)
    process.exit(1)
})
