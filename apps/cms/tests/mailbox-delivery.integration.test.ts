import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createLocalReq, getPayload } from 'payload'
import { hashOpaqueToken, newOpaqueToken } from '../src/identity'
import { prepareReply, authorizeReply, sendReply } from '../src/mail-replies'
import { dispatchOneNotification } from '../src/notification-dispatch'

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

test('notification delivery uses the notifications mapping once per recipient and never places private intake content on SMTP', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'notify-owner@example.test', name: 'Notify owner', roles: ['owner'] }, overrideAccess: true })
  const mailbox = await service.configureSMTPMailbox(payload, { name: 'Notification fixture mailbox', primaryAddress: 'notify@example.test', aliases: [], host: '127.0.0.1', port, security: 'starttls', username: 'notify-user', password: 'notify-password' }, owner.id)
  await service.testSMTPMailbox(payload, mailbox.id, owner.id)
  await service.setMailboxArea(payload, { area: 'notifications', mailbox: mailbox.id, senderAddress: 'notify@example.test' }, owner.id)
  const outbox = await payload.create({ collection: 'notification-outbox', data: { kind: 'new-lead', idempotencyKey: crypto.randomUUID(), state: 'queued', payload: { message: 'private inquiry body', resume: 'private-resume-key' }, recipientRules: ['owner'], recipients: [{ type: 'staff', id: owner.id, email: owner.email }], channels: ['email', 'sms'], sourceType: 'inquiry', sourceID: crypto.randomUUID(), availableAt: new Date().toISOString() }, overrideAccess: true })
  const before = messages.length
  await expect(dispatchOneNotification(payload)).resolves.toMatchObject({ state: 'delivered' })
  expect(messages).toHaveLength(before + 1)
  expect(messages.at(-1)).toContain(`Reference: ${outbox.id}`)
  expect(messages.at(-1)).not.toContain('private inquiry body')
  expect(messages.at(-1)).not.toContain('private-resume-key')
  await expect(dispatchOneNotification(payload)).resolves.toBeNull()
  const deliveries = await (payload as any).find({ collection: 'notification-deliveries', where: { outbox: { equals: outbox.id } }, limit: 0, pagination: false, overrideAccess: true })
  expect(deliveries.docs).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'delivered' }), expect.objectContaining({ state: 'unsupported', failureCode: 'channel-unsupported' })]))
  await expect(dispatchOneNotification(payload)).resolves.toBeNull()
  expect(messages).toHaveLength(before + 1)
})

test('notification claims are idempotent, stale leases never resend, and definite pre-send failures back off', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'notify-race-owner@example.test', name: 'Notify race owner', roles: ['owner'] }, overrideAccess: true })
  await service.clearMailboxArea(payload, 'notifications', owner.id)
  const createOutbox = () => payload.create({ collection: 'notification-outbox', data: { kind: 'new-lead', idempotencyKey: crypto.randomUUID(), state: 'queued', payload: {}, recipientRules: ['owner'], recipients: [{ type: 'staff', id: owner.id, email: owner.email }], channels: ['email'], sourceType: 'inquiry', sourceID: crypto.randomUUID(), availableAt: new Date().toISOString() }, overrideAccess: true })
  const unconfigured = await createOutbox()
  await expect(dispatchOneNotification(payload)).resolves.toMatchObject({ state: 'queued' })
  expect(await (payload as any).find({ collection: 'notification-deliveries', where: { outbox: { equals: unconfigured.id } }, limit: 1, overrideAccess: true })).toMatchObject({ docs: [expect.objectContaining({ state: 'queued', attempts: 0, failureCode: 'mailbox-not-configured' })] })
  await payload.update({ collection: 'notification-outbox', id: unconfigured.id, data: { state: 'failed' }, overrideAccess: true })
  const mailbox = await service.configureSMTPMailbox(payload, { name: 'Notification race mailbox', primaryAddress: 'notify-race@example.test', aliases: [], host: '127.0.0.1', port, security: 'starttls', username: 'notify-race-user', password: 'notify-race-password' }, owner.id)
  await service.testSMTPMailbox(payload, mailbox.id, owner.id)
  await service.setMailboxArea(payload, { area: 'notifications', mailbox: mailbox.id, senderAddress: 'notify-race@example.test' }, owner.id)

  const raced = await createOutbox(); const before = messages.length
  const results = await Promise.all([dispatchOneNotification(payload), dispatchOneNotification(payload)])
  expect(results.filter(Boolean)).toHaveLength(1)
  expect(messages).toHaveLength(before + 1)
  expect((await (payload as any).find({ collection: 'notification-deliveries', where: { outbox: { equals: raced.id } }, limit: 0, pagination: false, overrideAccess: true })).totalDocs).toBe(1)

  const stale = await createOutbox()
  await (payload as any).create({ collection: 'notification-deliveries', data: { outbox: stale.id, idempotencyKey: `${stale.id}:staff:${owner.id}:email`, recipient: { type: 'staff', id: owner.id, email: owner.email }, state: 'processing', attempts: 1, nextAttemptAt: new Date().toISOString(), leaseToken: 'crashed-before-result', leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() }, overrideAccess: true })
  await expect(dispatchOneNotification(payload)).resolves.toBeNull()
  expect(messages).toHaveLength(before + 1)
  expect(await (payload as any).find({ collection: 'notification-deliveries', where: { outbox: { equals: stale.id } }, limit: 1, overrideAccess: true })).toMatchObject({ docs: [expect.objectContaining({ state: 'processing' })] })

  const unavailable = await createOutbox()
  // Reconfiguration deliberately resets audited transport health to unknown;
  // this is a definite pre-send condition, not an ambiguous SMTP result.
  await service.configureSMTPMailbox(payload, { id: mailbox.id, name: 'Notification race mailbox', primaryAddress: 'notify-race@example.test', aliases: [], host: '127.0.0.1', port, security: 'starttls', username: 'notify-race-user' }, owner.id)
  let at = new Date()
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await expect(dispatchOneNotification(payload, at)).resolves.toMatchObject({ state: attempt === 5 ? 'failed' : 'retryable' })
    at = new Date(at.getTime() + 6 * 60_000)
  }
  expect(await (payload as any).find({ collection: 'notification-deliveries', where: { outbox: { equals: unavailable.id } }, limit: 1, overrideAccess: true })).toMatchObject({ docs: [expect.objectContaining({ state: 'failed', attempts: 5, failureCode: 'mailbox-not-ready' })] })
  expect(messages).toHaveLength(before + 1)
})

test('retention deletion removes notification receipts and refuses an active provider lease', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'notify-retention-owner@example.test', name: 'Notify retention owner', roles: ['owner'] }, overrideAccess: true })
  const inquiry = await (payload as any).create({ collection: 'inquiries', data: { name: 'Retention recipient', email: 'notify-retention@example.test', message: 'Synthetic retention record.', topic: 'general', sourcePage: '/test', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: crypto.randomUUID() }, overrideAccess: true })
  const outbox = await payload.create({ collection: 'notification-outbox', data: { inquiry: inquiry.id, kind: 'new-lead', idempotencyKey: crypto.randomUUID(), state: 'queued', payload: {}, recipientRules: ['owner'], recipients: [{ type: 'staff', id: owner.id, email: owner.email }], channels: ['email'], sourceType: 'inquiry', sourceID: inquiry.id, availableAt: new Date().toISOString() }, overrideAccess: true })
  const delivery = await (payload as any).create({ collection: 'notification-deliveries', data: { outbox: outbox.id, idempotencyKey: `${outbox.id}:staff:${owner.id}:email`, recipient: { type: 'staff', id: owner.id, email: owner.email }, state: 'processing', attempts: 1, nextAttemptAt: new Date().toISOString(), leaseToken: 'active-provider-attempt', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  const req = await createLocalReq({}, payload); req.context.retentionPurge = true
  await expect(payload.delete({ collection: 'inquiries', id: inquiry.id, overrideAccess: true, req })).rejects.toThrow('actively sending')
  await (payload as any).update({ collection: 'notification-deliveries', id: delivery.id, data: { state: 'unknown', leaseExpiresAt: null }, overrideAccess: true })
  await payload.delete({ collection: 'inquiries', id: inquiry.id, overrideAccess: true, req })
  expect((await (payload as any).find({ collection: 'notification-deliveries', where: { outbox: { equals: outbox.id } }, limit: 0, pagination: false, overrideAccess: true })).totalDocs).toBe(0)
})

test('terminal parents do not starve a later queued event and a revoked recipient is never sent', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'notify-fair-owner@example.test', name: 'Notify fair owner', roles: ['owner'] }, overrideAccess: true })
  const mailbox = await service.configureSMTPMailbox(payload, { name: 'Notification fair mailbox', primaryAddress: 'notify-fair@example.test', aliases: [], host: '127.0.0.1', port, security: 'starttls', username: 'notify-fair-user', password: 'notify-fair-password' }, owner.id)
  await service.testSMTPMailbox(payload, mailbox.id, owner.id)
  await service.setMailboxArea(payload, { area: 'notifications', mailbox: mailbox.id, senderAddress: 'notify-fair@example.test' }, owner.id)
  const make = (recipient = owner) => payload.create({ collection: 'notification-outbox', data: { kind: 'new-lead', idempotencyKey: crypto.randomUUID(), state: 'queued', payload: {}, recipientRules: ['owner'], recipients: [{ type: 'staff', id: recipient.id, email: recipient.email }], channels: ['email'], sourceType: 'inquiry', sourceID: crypto.randomUUID(), availableAt: new Date().toISOString() }, overrideAccess: true })
  const events = [] as Awaited<ReturnType<typeof make>>[]
  for (let index = 0; index < 26; index += 1) events.push(await make())
  const before = messages.length
  for (let index = 0; index < 26; index += 1) await expect(dispatchOneNotification(payload)).resolves.toMatchObject({ state: 'delivered' })
  expect(messages).toHaveLength(before + 26)
  for (const event of events) expect(await payload.findByID({ collection: 'notification-outbox', id: event.id, depth: 0, overrideAccess: true })).toMatchObject({ state: 'delivered' })

  const revoked = await payload.create({ collection: 'users', data: { email: 'notify-revoked@example.test', name: 'Notify revoked', roles: ['owner'], disabled: true }, overrideAccess: true })
  const unsent = await make(revoked)
  await expect(dispatchOneNotification(payload)).resolves.toMatchObject({ state: 'failed' })
  expect(messages).toHaveLength(before + 26)
  expect(await (payload as any).find({ collection: 'notification-deliveries', where: { outbox: { equals: unsent.id } }, limit: 1, overrideAccess: true })).toMatchObject({ docs: [expect.objectContaining({ failureCode: 'recipient-no-longer-eligible' })] })
})
