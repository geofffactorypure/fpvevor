import { config } from 'dotenv'
config({ path: './.env' })
config({ path: './.env.local', override: true })

import fs from 'fs'
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'

const TO = 'gjarman@factorypure.com'
const FROM = 'gjarman@factorypure.com'
const FILE = new URL('./vevor_sku_type_mapping.csv', import.meta.url)

async function main() {
    const csv = fs.readFileSync(FILE, 'utf-8')
    const rowCount = csv.split('\n').length - 1

    const ses = new SESClient({ region: 'us-east-2' })
    const boundary = '----boundary_' + Date.now().toString(16)
    const csvBase64 = Buffer.from(csv).toString('base64')

    const rawMessage = [
        `From: ${FROM}`,
        `To: ${TO}`,
        `Subject: Vevor SKU Type Mapping — ${rowCount} rows`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset=UTF-8`,
        ``,
        `Attached: vevor_sku_type_mapping.csv (${rowCount} rows)`,
        ``,
        `--${boundary}`,
        `Content-Type: text/csv; name="vevor_sku_type_mapping.csv"`,
        `Content-Disposition: attachment; filename="vevor_sku_type_mapping.csv"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        csvBase64,
        ``,
        `--${boundary}--`,
    ].join('\r\n')

    await ses.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(rawMessage) } }))
    console.log(`Email sent to ${TO}`)
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
