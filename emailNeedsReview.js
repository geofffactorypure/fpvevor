/**
 * Email the needs_review.txt file as a CSV with headers.
 *
 * Usage:
 *   node emailNeedsReview.js
 */

import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'
import fs from 'fs'

const TO = 'gjarman@factorypure.com'
const FROM = 'gjarman@factorypure.com'
const SUBJECT = 'Vevor Products — Needs Review'
const FILE_PATH = './needs_review.txt'
const CSV_NAME = 'needs_review.csv'

if (!fs.existsSync(FILE_PATH)) {
    console.error(`File not found: ${FILE_PATH}`)
    process.exit(1)
}

// Convert tab-separated txt to CSV with headers
const lines = fs.readFileSync(FILE_PATH, 'utf-8').trim().split('\n')
const csvRows = ['id,product_type,title']
for (const line of lines) {
    const [id, productType, title] = line.split('\t')
    // Escape fields for CSV
    const escape = (val) => `"${(val || '').replace(/"/g, '""')}"`
    csvRows.push(`${id},${escape(productType)},${escape(title)}`)
}
const csvContent = csvRows.join('\r\n')
const base64Csv = Buffer.from(csvContent).toString('base64')

const boundary = '----boundary_' + Date.now().toString(16)

const rawMessage = [
    `From: ${FROM}`,
    `To: ${TO}`,
    `Subject: ${SUBJECT}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    `Attached is a CSV of ${lines.length} Vevor product(s) flagged for product type review.`,
    ``,
    `--${boundary}`,
    `Content-Type: text/csv; name="${CSV_NAME}"`,
    `Content-Disposition: attachment; filename="${CSV_NAME}"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    base64Csv,
    ``,
    `--${boundary}--`,
].join('\r\n')

const ses = new SESClient({ region: 'us-east-2' })

try {
    await ses.send(
        new SendRawEmailCommand({
            RawMessage: { Data: Buffer.from(rawMessage) },
        })
    )
    console.log(`Email sent to ${TO} with ${CSV_NAME} (${lines.length} products)`)
} catch (err) {
    console.error('Failed to send email:', err.message)
    process.exit(1)
}
