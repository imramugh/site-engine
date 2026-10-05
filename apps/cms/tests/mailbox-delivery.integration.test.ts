import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPayload } from 'payload'

const directory = mkdtempSync(join(tmpdir(), 'mailbox-delivery-'))
Object.assign(process.env, { DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`, PAYLOAD_SECRET: 'mailbox-delivery-test-secret', PAYLOAD_PUBLIC_SERVER_URL: 'http://cms.example.test', INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'), MAIL_TEST_SMTP_LOOPBACK: '1' })
const { default: config } = await import('../payload.config.js'); const service = await import('../src/mailboxes.js')
let payload: Awaited<ReturnType<typeof getPayload>>; let smtp: Server; let port = 0; const messages: string[] = []

beforeAll(async () => {
  payload = await getPayload({ config })
  smtp = createServer((socket) => {
    let buffer = ''; let data = false
    socket.write('220 synthetic-smtp ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      while (true) {
        if (data) { const end = buffer.indexOf('\r\n.\r\n'); if (end < 0) return; messages.push(buffer.slice(0, end)); buffer = buffer.slice(end + 5); data = false; socket.write('250 2.0.0 queued\r\n'); continue }
        const end = buffer.indexOf('\r\n'); if (end < 0) return; const line = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        if (/^EHLO /i.test(line)) socket.write('250-synthetic-smtp\r\n250 AUTH PLAIN\r\n')
        else if (/^AUTH PLAIN /i.test(line)) socket.write('235 2.7.0 authenticated\r\n')
        else if (/^RCPT TO:<reject@example\.test>$/i.test(line)) socket.write('550 5.1.1 rejected\r\n')
        else if (/^(MAIL FROM|RCPT TO):/i.test(line)) socket.write('250 2.1.0 ok\r\n')
        else if (/^DATA$/i.test(line)) { data = true; socket.write('354 end with dot\r\n') }
        else if (/^QUIT$/i.test(line)) { socket.write('221 bye\r\n'); socket.end() }
        else socket.write('250 ok\r\n')
      }
    })
  })
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', () => { port = (smtp.address() as { port: number }).port; resolve() }))
})
afterAll(async () => { await payload.destroy(); await new Promise<void>((resolve) => smtp.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); for (const key of ['INTEGRATION_CREDENTIAL_ENCRYPTION_KEY', 'MAIL_TEST_SMTP_LOOPBACK']) delete process.env[key] })

test('SMTP credentials stay private while mappings and one-use authorized delivery are real', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'mail-owner@example.test', name: 'Mail owner', roles: ['owner'] }, overrideAccess: true })
  const mailbox = await service.configureSMTPMailbox(payload, { name: 'Synthetic mailbox', primaryAddress: 'hello@example.test', aliases: ['careers@example.test'], host: '127.0.0.1', port, security: 'starttls', username: 'synthetic-user', password: 'synthetic-password' }, owner.id)
  expect(JSON.stringify(service.publicMailbox(mailbox as never))).not.toContain('synthetic-password')
  expect(await service.testSMTPMailbox(payload, mailbox.id, owner.id)).toMatchObject({ health: 'connected' })
  await expect(service.setMailboxArea(payload, { area: 'careers', mailbox: mailbox.id, senderAddress: 'careers@example.test' }, owner.id)).rejects.toThrow('not been verified')
  await service.setMailboxArea(payload, { area: 'leads', mailbox: mailbox.id, senderAddress: 'hello@example.test' }, owner.id)
  const input = { requestKey: crypto.randomUUID(), mailbox: mailbox.id, senderAddress: 'careers@example.test', recipientAddress: 'sink@example.test', subject: 'Synthetic delivery', body: 'Only the local sink receives this message.', confirmed: true }
  const sent = await service.sendAuthorizedMailboxTest(payload, input, owner.id); expect(sent).toMatchObject({ state: 'sent' }); expect(messages).toHaveLength(1); expect(messages[0]).toContain('Only the local sink receives this message.')
  await service.setMailboxArea(payload, { area: 'careers', mailbox: mailbox.id, senderAddress: 'careers@example.test' }, owner.id)
  await expect(service.configureSMTPMailbox(payload, { id: mailbox.id, name: 'Synthetic mailbox', primaryAddress: 'hello@example.test', aliases: [], host: '127.0.0.1', port, security: 'starttls', username: 'synthetic-user' }, owner.id)).rejects.toThrow('Unassign this mailbox sender')
  await service.clearMailboxArea(payload, 'careers', owner.id)
  await service.setMailboxArea(payload, { area: 'careers', mailbox: mailbox.id, senderAddress: 'careers@example.test' }, owner.id)
  await expect(service.sendAuthorizedMailboxTest(payload, { ...input, body: 'Changed after authorization.' }, owner.id)).rejects.toThrow('different content')
  expect(await service.sendAuthorizedMailboxTest(payload, input, owner.id)).toMatchObject({ id: sent.id, state: 'sent' }); expect(messages).toHaveLength(1)
  const rejectedKey = crypto.randomUUID()
  await expect(service.sendAuthorizedMailboxTest(payload, { ...input, requestKey: rejectedKey, recipientAddress: 'reject@example.test' }, owner.id)).rejects.toThrow('could not be delivered')
  expect((await payload.find({ collection: 'mailbox-test-sends', where: { requestKey: { equals: rejectedKey } }, overrideAccess: true })).docs[0]).toMatchObject({ state: 'failed', failureCode: 'provider_unavailable' })
  expect((await payload.find({ collection: 'audit-events', where: { event: { equals: 'mailbox.test_send_completed' } }, overrideAccess: true })).docs).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.objectContaining({ state: 'failed' }) })]))
  const workspace = await service.mailboxWorkspace(payload); expect(workspace.mappings).toEqual(expect.arrayContaining([{ id: expect.any(String), area: 'careers', mailbox: mailbox.id, senderAddress: 'careers@example.test' }])); expect(JSON.stringify(workspace)).not.toContain('synthetic-password')
})
