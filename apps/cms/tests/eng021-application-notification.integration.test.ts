import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPayload } from 'payload'
import { dispatchOneNotification } from '../src/notification-dispatch'

const directory = mkdtempSync(join(tmpdir(), 'eng021-application-notification-'))
Object.assign(process.env, {
  DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`,
  PAYLOAD_SECRET: 'eng021-application-notification-test-secret',
  PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.example.test',
  INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 21).toString('base64url'),
  MAIL_TEST_SMTP_LOOPBACK: '1',
})
const { default: config } = await import('../payload.config.js')
const mailboxes = await import('../src/mailboxes.js')
let payload: Awaited<ReturnType<typeof getPayload>>
let smtp: Server
let port = 0
const recipients: string[] = []
const messages: string[] = []

beforeAll(async () => {
  payload = await getPayload({ config })
  smtp = createServer((socket) => {
    let buffer = ''; let data = false
    socket.write('220 eng021-smtp ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      while (true) {
        if (data) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          messages.push(buffer.slice(0, end)); buffer = buffer.slice(end + 5); data = false; socket.write('250 2.0.0 queued\r\n'); continue
        }
        const end = buffer.indexOf('\r\n')
        if (end < 0) return
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        if (/^EHLO /i.test(line)) socket.write('250-eng021-smtp\r\n250 AUTH PLAIN\r\n')
        else if (/^AUTH PLAIN /i.test(line)) socket.write('235 2.7.0 authenticated\r\n')
        else if (/^RCPT TO:<([^>]+)>$/i.test(line)) { recipients.push(line.slice(9, -1).toLowerCase()); socket.write('250 2.1.0 ok\r\n') }
        else if (/^MAIL FROM:/i.test(line)) socket.write('250 2.1.0 ok\r\n')
        else if (/^DATA$/i.test(line)) { data = true; socket.write('354 end with dot\r\n') }
        else if (/^QUIT$/i.test(line)) { socket.write('221 bye\r\n'); socket.end() }
        else socket.write('250 ok\r\n')
      }
    })
  })
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', () => { port = (smtp.address() as { port: number }).port; resolve() }))
})

afterAll(async () => {
  await payload?.destroy()
  await new Promise<void>((resolve) => smtp.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
  delete process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
  delete process.env.MAIL_TEST_SMTP_LOOPBACK
})

test('ENG-021 application create hook delivers only to active Hiring and Owner recipients without exposing intake data', async () => {
  const owner = await payload.create({ collection: 'users', data: { name: 'ENG-021 Owner', email: 'eng021-owner@example.test', roles: ['owner'] }, overrideAccess: true })
  const hiring = await payload.create({ collection: 'users', data: { name: 'ENG-021 Hiring', email: 'eng021-hiring@example.test', roles: ['hiring'] }, overrideAccess: true })
  await payload.create({ collection: 'users', data: { name: 'ENG-021 Sales', email: 'eng021-sales@example.test', roles: ['sales'] }, overrideAccess: true })
  await payload.create({ collection: 'users', data: { name: 'Disabled Hiring', email: 'eng021-disabled@example.test', roles: ['hiring'], disabled: true }, overrideAccess: true })
  const mailbox = await mailboxes.configureSMTPMailbox(payload, { name: 'ENG-021 notifications', primaryAddress: 'notify-eng021@example.test', aliases: [], host: '127.0.0.1', port, security: 'starttls', username: 'eng021-notify', password: 'eng021-notify-password' }, owner.id)
  await expect(mailboxes.testSMTPMailbox(payload, mailbox.id, owner.id)).resolves.toMatchObject({ health: 'connected' })
  await mailboxes.setMailboxArea(payload, { area: 'notifications', mailbox: mailbox.id, senderAddress: 'notify-eng021@example.test' }, owner.id)

  const resumeKey = `eng021-${'a'.repeat(64)}`
  const application = await payload.create({ collection: 'applications', data: { name: 'Private ENG-021 Applicant', email: 'private-applicant@example.test', coverLetter: 'This private cover letter must never leave the CMS.', consent: true, jobId: '00000000-0000-4000-8000-000000000021', resumeKey, idempotencyKey: '00000000-0000-4000-8000-000000000022' }, overrideAccess: true })
  const outbox = await payload.find({ collection: 'notification-outbox', where: { sourceID: { equals: application.id } }, limit: 1, depth: 0, overrideAccess: true })
  expect(outbox.docs[0]).toMatchObject({ kind: 'new-job-application', recipientRules: ['hiring', 'owner'], recipients: expect.arrayContaining([{ type: 'staff', id: owner.id, email: owner.email }, { type: 'staff', id: hiring.id, email: hiring.email }]) })
  expect(outbox.docs[0]?.recipients).not.toEqual(expect.arrayContaining([expect.objectContaining({ email: 'eng021-sales@example.test' }), expect.objectContaining({ email: 'eng021-disabled@example.test' })]))

  const before = messages.length
  await expect(dispatchOneNotification(payload)).resolves.toMatchObject({ state: 'delivered' })
  await expect(dispatchOneNotification(payload)).resolves.toMatchObject({ state: 'delivered' })
  expect(recipients.slice(-2).sort()).toEqual([owner.email, hiring.email].sort())
  expect(messages).toHaveLength(before + 2)
  for (const message of messages.slice(-2)) {
    expect(message).toContain(`Reference: ${outbox.docs[0]!.id}`)
    expect(message).not.toContain(application.email)
    expect(message).not.toContain(application.coverLetter)
    expect(message).not.toContain(resumeKey)
  }
  expect(await payload.findByID({ collection: 'notification-outbox', id: outbox.docs[0]!.id, depth: 0, overrideAccess: true })).toMatchObject({ state: 'delivered' })
})
