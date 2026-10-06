import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPayload } from 'payload'
import { dispatchOneNotification } from '../src/notification-dispatch'
import { enqueueNotification } from '../src/notification-settings'

const directory = mkdtempSync(join(tmpdir(), 'publish-failure-notification-'))
Object.assign(process.env, {
  DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`,
  PAYLOAD_SECRET: 'publish-failure-notification-test-secret',
  PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.example.test',
  INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64url'),
  MAIL_TEST_SMTP_LOOPBACK: '1',
})

const { default: config } = await import('../payload.config.js')
const mailboxes = await import('../src/mailboxes.js')
let payload: Awaited<ReturnType<typeof getPayload>>
let smtp: Server
let port = 0
const messages: string[] = []

beforeAll(async () => {
  payload = await getPayload({ config })
  smtp = createServer((socket) => {
    let buffer = ''; let data = false
    socket.write('220 test-smtp ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      while (true) {
        if (data) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          messages.push(buffer.slice(0, end)); buffer = buffer.slice(end + 5); data = false; socket.write('250 queued\r\n'); continue
        }
        const end = buffer.indexOf('\r\n')
        if (end < 0) return
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        if (/^EHLO /i.test(line)) socket.write('250-test-smtp\r\n250 AUTH PLAIN\r\n')
        else if (/^AUTH PLAIN /i.test(line)) socket.write('235 authenticated\r\n')
        else if (/^(MAIL FROM|RCPT TO):/i.test(line)) socket.write('250 accepted\r\n')
        else if (/^DATA$/i.test(line)) { data = true; socket.write('354 continue\r\n') }
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
  for (const key of ['INTEGRATION_CREDENTIAL_ENCRYPTION_KEY', 'MAIL_TEST_SMTP_LOOPBACK']) delete process.env[key]
})

test('ENG-010 notifies Owners of an unconfirmed publication through missing-mailbox retry', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'publish-owner@example.test', name: 'Publish owner', roles: ['owner'] }, overrideAccess: true })
  await payload.create({ collection: 'users', data: { email: 'editor@example.test', name: 'Editor', roles: ['editor'] }, overrideAccess: true })
  const publishJob = crypto.randomUUID()
  const notification = await enqueueNotification(payload, undefined, {
    kind: 'publish-or-integration-failed',
    idempotencyKey: `publish-failed:${publishJob}`,
    sourceType: 'publish-job',
    sourceID: publishJob,
    payload: { publishJob, errorCode: '<untrusted-worker-error: private build output>' },
  })
  expect(notification).toMatchObject({ recipientRules: ['owner'], recipients: [{ type: 'staff', id: owner.id, email: owner.email }], state: 'queued' })

  const firstAttempt = new Date(Date.now() + 1_000)
  await expect(dispatchOneNotification(payload, firstAttempt)).resolves.toMatchObject({ state: 'queued' })
  expect(messages).toHaveLength(0)
  const queued = await (payload as any).find({ collection: 'notification-deliveries', where: { outbox: { equals: notification!.id } }, limit: 1, overrideAccess: true })
  expect(queued.docs[0]).toMatchObject({ state: 'queued', attempts: 0, failureCode: 'mailbox-not-configured' })

  const mailbox = await mailboxes.configureSMTPMailbox(payload, { name: 'Publish failure test mailbox', primaryAddress: 'notices@example.test', aliases: [], host: '127.0.0.1', port, security: 'starttls', username: 'test-user', password: 'test-password' }, owner.id)
  await mailboxes.testSMTPMailbox(payload, mailbox.id, owner.id)
  await mailboxes.setMailboxArea(payload, { area: 'notifications', mailbox: mailbox.id, senderAddress: 'notices@example.test' }, owner.id)
  await expect(dispatchOneNotification(payload, new Date(firstAttempt.getTime() + 6 * 60_000))).resolves.toMatchObject({ state: 'delivered' })

  expect(messages).toHaveLength(1)
  const deliveredMessage = messages[0]!.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  expect(deliveredMessage).toContain('Publish build failed')
  expect(deliveredMessage).toContain('A publication could not be completed or confirmed. Review its build log before retrying.')
  expect(deliveredMessage).toContain(`Reference: ${notification!.id}`)
  expect(deliveredMessage).toContain(`Open: https://cms.example.test/operations?publish=${publishJob}`)
  expect(deliveredMessage).not.toContain('<untrusted-worker-error: private build output>')
  const delivered = await payload.findByID({ collection: 'notification-outbox', id: notification!.id, depth: 0, overrideAccess: true })
  expect(delivered).toMatchObject({ state: 'delivered' })
})
