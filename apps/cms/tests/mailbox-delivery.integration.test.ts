import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPayload } from 'payload'
import { hashOpaqueToken, newOpaqueToken } from '../src/identity'
import { prepareReply, authorizeReply, sendReply } from '../src/mail-replies'

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
  for (const address of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::', '0.0.0.0', '100.64.0.1', '198.51.100.1', 'fc00::1', 'fe80::1', '2001:db8::1']) expect(service.isPublicSMTPAddress(address)).toBe(false)
  for (const address of ['8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(service.isPublicSMTPAddress(address)).toBe(true)
  const owner = await payload.create({ collection: 'users', data: { email: 'mail-owner@example.test', name: 'Mail owner', roles: ['owner'] }, overrideAccess: true })
  const mailbox = await service.configureSMTPMailbox(payload, { name: 'Synthetic mailbox', primaryAddress: 'hello@example.test', aliases: ['careers@example.test'], host: '127.0.0.1', port, security: 'starttls', username: 'synthetic-user', password: 'synthetic-password' }, owner.id)
  expect(String(mailbox.credentialRevision)).toMatch(/^[a-f0-9]{16}$/)
  expect(mailbox.credentialRevision).not.toBe(createHash('sha256').update('synthetic-password').digest('hex').slice(0, 12))
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
  await expect(service.configureSMTPMailbox(payload, { id: mailbox.id, name: 'Synthetic mailbox', primaryAddress: 'hello@example.test', aliases: ['careers@example.test'], host: 'smtp.changed.example.test', port, security: 'starttls', username: 'changed-user' }, owner.id)).rejects.toThrow('Unassign this mailbox sender')
  await service.clearMailboxArea(payload, 'careers', owner.id)
  const changed = await service.configureSMTPMailbox(payload, { id: mailbox.id, name: 'Synthetic mailbox', primaryAddress: 'hello@example.test', aliases: ['careers@example.test'], host: 'smtp.changed.example.test', port, security: 'starttls', username: 'changed-user' }, owner.id)
  expect(changed).toMatchObject({ verifiedAliases: [], health: 'unknown', testedAt: null })
})


test('a reviewed lead reply reaches SMTP once with the exact confirmed content', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'reply-owner@example.test', name: 'Reply owner', roles: ['owner'] }, overrideAccess: true })
  const mailbox = await service.configureSMTPMailbox(payload, { name: 'Reply fixture mailbox', primaryAddress: 'replies@example.test', aliases: [], host: '127.0.0.1', port, security: 'starttls', username: 'reply-user', password: 'reply-password' }, owner.id)
  await service.testSMTPMailbox(payload, mailbox.id, owner.id)
  await service.setMailboxArea(payload, { area: 'leads', mailbox: mailbox.id, senderAddress: 'replies@example.test' }, owner.id)
  const lead = await payload.create({ collection: 'inquiries', data: { email: 'reply-recipient@example.test', message: 'Please reply to this synthetic inquiry.', topic: 'general', sourcePage: '/contact', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: crypto.randomUUID(), stage: 'new' }, overrideAccess: true })
  const token = newOpaqueToken()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: owner.id, authenticatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  const actor = { id: owner.id, sessionToken: token }
  const draft = await prepareReply(payload, 'lead', lead.id, owner.id, { sender: 'replies@example.test', subject: 'Reviewed reply fixture', body: 'This exact reviewed message reaches only the local SMTP sink.' })
  const grant = await authorizeReply(payload, actor, draft.id)
  const before = messages.length
  await expect(sendReply(payload, actor, grant.id)).resolves.toMatchObject({ provider: 'smtp', messageID: expect.any(String) })
  expect(messages).toHaveLength(before + 1)
  expect(messages.at(-1)).toContain('Reviewed reply fixture')
  expect(messages.at(-1)).toContain('This exact reviewed message reaches only the local SMTP sink.')
  await expect(sendReply(payload, actor, grant.id)).rejects.toThrow('authorization_not_usable')
  expect(messages).toHaveLength(before + 1)
  expect(await payload.findByID({ collection: 'mail-drafts', id: draft.id, overrideAccess: true })).toMatchObject({ state: 'sent' })
})
