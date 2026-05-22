/**
 * Email the needs_review.txt file.
 *
 * Usage:
 *   node emailNeedsReview.js
 */

import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'
import fs from 'fs'
import path from 'path'

const TO = 'gjarman@factorypure.com'
const FROM = 'gjarman@factorypure.com'
const SUBJECT = 'Vevor Products — Needs Review'
const FILE_PATH = './needs_review.txt'

if (!fs.existsSync(FILE_PATH)) {
    console.error(`File not found: ${FILE_PATH}`)
    process.exit(1)
}

const fileContent = fs.readFileSync(FILE_PATH)
const fileName = path.basename(FILE_PATH)
const base64File = fileContent.toString('base64')

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
    `Attached is the needs_review.txt file containing Vevor products flagged for product type review.`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; name="${fileName}"`,
    `Content-Disposition: attachment; filename="${fileName}"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    base64File,
    ``,
    `--${boundary}--`,
].join('\r\n')

const ses = new SESClient({ region: 'us-east-1' })

try {
    await ses.send(
        new SendRawEmailCommand({
            RawMessage: { Data: Buffer.from(rawMessage) },
        })
    )
    console.log(`Email sent to ${TO} with attachment ${fileName}`)
} catch (err) {
    console.error('Failed to send email:', err.message)
    process.exit(1)
}
