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
        16870211609, 27704852505, 115732054041, 115738935321, 115741294617, 16844357657, 24880906265, 2412539347026,
        2412559958098, 8234372071613, 8234380427453, 7701845901501, 8210615632061, 7560338309309, 7560334540989,
        7560333230269, 7560331428029, 7571813990589, 7571765887165, 7571759071421, 7571745243325, 128021528601,
        8310908813501, 8310811885757, 8310439116989, 2482016616530, 8053425078461, 8310693036221, 8310694052029,
        8310657712317, 8310667280573, 8310693888189, 8310676455613, 8310699786429, 8310693986493, 8310693920957,
        8311024025789, 8303430926525, 8303466905789, 8297859580093, 8303448948925, 8297783492797, 8195352789181,
        8231575453885, 8227053109437, 8227018113213, 8227008184509, 8228707696829, 8252901785789, 8252908601533,
        8253492101309, 8231565525181, 8203514806461, 8296197685437, 8296212136125, 4594915377234, 7573728886973,
        7858235441341, 7856257040573, 8158434328765, 8103570636989, 8159169249469, 8108291555517, 7118721581245,
        7554977628349, 7456173326525, 7347635880125, 7432062664893, 7432384250045, 7507051315389, 7458087993533,
        7469912424637, 7496698659005, 7464113832125, 7510341288125, 7887338897597, 7903460786365, 7904569262269,
        8329853927613, 8329854091453, 7931677442237, 8277689368765, 7919562490045, 8310258270397, 8310288875709,
        8310258335933, 8310258237629, 8310258204861, 8310966550717, 8310966747325, 8310976053437, 8310977396925,
        8310986899645, 8310986866877, 8310986637501, 8310975922365, 8310976315581, 8310975987901, 8310425845949,
        8310417490109, 8310430171325, 8310430204093, 8310430236861, 8310430335165, 8310430466237, 8310417227965,
        8310417326269, 8310417129661, 8310417162429, 8310417195197, 8310427058365, 8310427648189, 8310427484349,
        8310427320509, 8310426927293, 6719911297213, 6422561158, 6418809030, 6422609926, 6422627846, 6343837254,
        6343784518, 6418677254, 1392360194157, 4560556294226, 7429432115389, 8310561341629, 8329851633853,
        8329850945725, 8329850847421, 8329850814653, 8329850683581, 8310470017213, 8313699664061, 8310907076797,
        8310903341245, 8310892069053, 8310893641917, 8310893674685, 8310588080317, 8310610854077, 8310588178621,
        8310619701437, 8310610690237, 8310588342461, 8310621733053, 1414789300333, 7857146167485, 7003860271293,
        7003884683453, 8310886006973, 8310887481533, 8310888366269, 8310325477565, 8310325313725, 8310747070653,
        8310364963005, 8310365847741, 8310365225149, 7865916227773, 8038329352381, 8260862378173, 8314100482237,
        7580105801917, 7579700396221, 7579791950013, 7600859971773, 7579747745981, 8282921861309, 8282916585661,
        8282920321213, 8198312755389, 8282918650045, 7468732481725, 7455748391101, 7204338204861, 7414604923069,
        7414302441661, 7358918754493, 7177544761533, 8036600709309, 7974415564989, 7974406684861, 7974407995581,
        7974408847549, 7974409830589, 3958091645010, 4494446657618, 4488670937170, 4483817144402, 144952557593,
        4483812294738, 4032635043922, 4430950203474, 4426774413394, 6632476278973, 2428737585234, 3957849161810,
        4200714240082, 2499590258770, 2499596681298, 4833838858322, 4833703624786, 4527589032018, 4289932591186,
        4642702032978, 4553436790866, 4553453109330, 4553464184914, 4292642734162, 8329852649661, 8329853206717,
        7882280272061, 7834148176061, 7857125785789, 7809614053565, 7971614392509, 7980668027069, 7972851122365,
        7956749189309, 2412624412754, 2413514260562, 2413539197010, 4494951710802, 8310471852221, 8310959276221,
        7997528441021, 7997521756349, 8180688715965, 8310870442173, 8310876864701, 8310877880509, 8310869328061,
        8310869459133, 8310869262525, 8310864806077, 8310869524669, 8310869229757, 8310869590205, 8310777938109,
        8310778003645, 8310777675965, 8310777643197, 8310777970877, 8310392160445, 8310390554813, 8310391898301,
        8310392127677, 8290632401085, 8290661367997, 7914665312445, 7953398333629, 8310340026557, 8310329278653,
        8310328918205, 8310340354237, 8310328852669, 8310782984381, 8310783934653, 8310892298429, 8310915432637,
        8310915694781, 8310919921853, 8310923690173, 8310930047165, 8310591062205, 8310593847485, 8310593913021,
        8310594011325, 8310594142397, 8310591979709, 8310593683645, 8310592372925, 8310587424957, 7901913186493,
        7985676714173, 7985359519933, 8309694726333, 8288134398141, 7876654596285, 7512540119229, 4738016968786,
        8310565503165, 8310938468541, 8310938992829, 8310939091133, 8310938337469, 8297562439869, 8297561620669,
        8060460925117, 8061975003325, 8060453224637, 8067047686333, 8296250998973, 8296259289277, 7904947929277,
        7904929906877, 7877709627581, 7659185012925, 8297643802813, 7125800452285, 7125288288445, 4037397839954,
        4493695582290, 8092852584637, 8310892265661, 7296748585149, 7455024054461, 7264195379389, 7455005638845,
        7454177427645, 7296447381693, 7290371473597, 7455166234813, 7289561710781, 7289479364797, 7715422077117,
        7715406020797, 7715370139837, 7715311124669, 8241098752189, 8062425727165, 8063573655741, 7830124888253,
        8310962979005, 8090561151165, 8090547650749, 8090513637565, 8088590024893, 8090637336765, 8088383979709,
        8108319506621, 8090698973373, 7881466413245, 7881434529981, 7881498263741, 7882271097021, 7882274767037,
        7844841914557, 7764886192317, 7863797350589, 7762703450301, 7843258073277, 7863783456957, 7945027911869,
        7996450078909, 7305665806525, 8214507913405, 8198011027645, 7877727584445, 7884481036477, 7925669757117,
        8329854550205, 8329854582973, 8310241362109, 8310241067197, 8310241132733, 8310966714557, 8310966649021,
        8310912680125, 8310966616253, 8310330196157, 8310330163389, 2345174696018, 8310736158909, 8310735405245,
        8310726033597, 8310732259517, 8310256599229, 8310256107709, 8310426206397, 8310425878717, 7923478462653,
        7900220850365, 8038307889341, 8221005054141, 8310932308157, 8310921035965, 8310920937661, 8310431318205,
        8310432366781, 8310430695613, 8310430400701, 8310430433469, 8311030284477, 8311029891261, 8311029924029,
        8310940926141, 8310941450429, 8310941155517, 8310940467389, 8310940532925, 8310941286589, 7069034250429,
        8059265581245, 7211947655357, 7211971018941, 7142365954237, 7144386953405, 7211938218173, 7211587731645,
        7211653693629, 7211943657661, 7211662213309, 7211696521405, 7211675582653, 7211693899965, 7211685871805,
        8236519293117, 8019964035261, 8019972849853, 8019996115133, 8019968491709, 8020125319357, 7827978289341,
        8310888202429, 8310888595645, 8310627172541, 8310953574589, 8310954426557, 8310712631485, 8310469951677,
        8310470901949, 8310470705341, 8310975692989, 8310988439741, 8310980608189, 8310989422781, 8310310666429,
        8310310109373, 8310310174909, 8310560981181, 8310560063677, 8310886236349, 8310975889597, 8311028711613,
        8235026219197, 8074500178109, 8310673146045, 7031058956477, 7032269832381, 7032428298429, 8096525451453,
        8096170377405, 8096536821949, 8096528433341, 8097771323581, 8096159695037, 8096584859837, 8096612516029,
        8096165560509, 8096574505149, 8096542851261, 8096549929149, 7428692017341, 7428683464893, 7428660428989,
        7428612653245, 7427680927933, 7428954456253, 7428695523517, 7428956487869, 7428958650557, 7428963238077,
        7428964843709, 7428953702589, 8190318903485, 8283615428797, 7427765272765, 7427762520253, 8201615933629,
        8249796395197, 8096652656829, 7466131914941, 7987709444285, 8010888347837, 7987661209789,
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
