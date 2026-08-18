/**
 * registerGrizzlyCarrierService.js
 *
 * One-time script. Registers a carrier service named "FactoryPure Shipping" with
 * Shopify and points it at the grizzlyRates endpoint in fphooks-server.
 *
 * After running this script:
 *  1. Go to Shopify Admin → Settings → Shipping and delivery
 *  2. Create a new profile named "FactoryPure Shipping"
 *  3. Add a United States zone → Add rate → "Use carrier or app to calculate
 *     rates" → select "FactoryPure Shipping"
 *  4. Save. Note the delivery profile GID (from URL or via GraphQL
 *     deliveryProfiles query) and save as GRIZZLY_DELIVERY_PROFILE_ID in .env
 *
 * Usage:
 *   node registerGrizzlyCarrierService.js
 */

import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fetch from 'node-fetch'

const SHOPIFY_STORE = 'factorypure.myshopify.com'
const SHOPIFY_API_VERSION = '2025-01'
const CALLBACK_URL = 'https://www.fpapplications.com/shippingRates'

const { SHOPIFY_FPDASH_TOKEN } = process.env

if (!SHOPIFY_FPDASH_TOKEN) {
    console.error('SHOPIFY_FPDASH_TOKEN is not set')
    process.exit(1)
}

async function main() {
    // 1. Check if service already exists
    console.log('Checking for existing carrier services...')
    const listRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/carrier_services.json`, {
        headers: {
            'X-Shopify-Access-Token': SHOPIFY_FPDASH_TOKEN,
            'Content-Type': 'application/json',
        },
    })
    const listData = await listRes.json()

    if (listData.errors) {
        console.error('Error fetching carrier services:', listData.errors)
        process.exit(1)
    }

    const existing = (listData.carrier_services || []).find((s) => s.name === 'FactoryPure Shipping')
    if (existing) {
        console.log('Carrier service "FactoryPure Shipping" already exists:')
        console.log(JSON.stringify(existing, null, 2))
        return
    }

    // 2. Register carrier service
    console.log('Registering "FactoryPure Shipping" carrier service...')
    const createRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/carrier_services.json`, {
        method: 'POST',
        headers: {
            'X-Shopify-Access-Token': SHOPIFY_FPDASH_TOKEN,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            carrier_service: {
                name: 'FactoryPure Shipping',
                callback_url: CALLBACK_URL,
                service_discovery: true,
                format: 'json',
                active: true,
            },
        }),
    })

    const createData = await createRes.json()

    if (createData.errors) {
        console.error('Error creating carrier service:', JSON.stringify(createData.errors, null, 2))
        process.exit(1)
    }

    console.log('\n✓ Carrier service created successfully:')
    console.log(JSON.stringify(createData.carrier_service, null, 2))
    console.log('\nNext steps:')
    console.log('  1. Shopify Admin → Settings → Shipping and delivery')
    console.log('  2. Create profile "FactoryPure Shipping"')
    console.log('  3. Add United States zone → Add rate → Use carrier → "FactoryPure Shipping"')
    console.log('  4. Save, note the delivery profile GID, add to .env as GRIZZLY_DELIVERY_PROFILE_ID')
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
