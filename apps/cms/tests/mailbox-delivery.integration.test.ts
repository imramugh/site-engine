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
import { startMailboxOAuth, completeMailboxOAuth, decryptMailboxOAuthCredential } from '../src/mailbox-oauth'

const directory = mkdtempSync(join(tmpdir(), 'mailbox-delivery-'))
Object.assign(process.env, { DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`, PAYLOAD_SECRET: 'mailbox-delivery-test-secret', PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.example.test', MAILBOX_MICROSOFT_CLIENT_ID: 'microsoft-client', MAILBOX_MICROSOFT_CLIENT_SECRET: 'microsoft-secret', MAILBOX_GOOGLE_CLIENT_ID: 'google-client', MAILBOX_GOOGLE_CLIENT_SECRET: 'google-secret', INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'), MAIL_TEST_SMTP_LOOPBACK: '1' })
const { default: config } = await import('../payload.config.js'); const service = await import('../src/mailboxes.js'); const oauth = { startMailboxOAuth, completeMailboxOAuth, decryptMailboxOAuthCredential }
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
  expect(await (payload as any).find({ collection: 'notification-deliveries', where: { outbox: { equals: stale.id } }, limit: 1, overrideAccess: true })).toMatchObject({ docs: [expect.objectContaining({ state: 'unknown', failureCode: 'lease-expired-outcome-unknown' })] })

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

test('expired processing receipts become unknown and release the first-25 window', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'notify-stale-owner@example.test', name: 'Notify stale owner', roles: ['owner'] }, overrideAccess: true })
  const mailbox = await service.configureSMTPMailbox(payload, { name: 'Notification stale mailbox', primaryAddress: 'notify-stale@example.test', aliases: [], host: '127.0.0.1', port, security: 'starttls', username: 'notify-stale-user', password: 'notify-stale-password' }, owner.id); await service.testSMTPMailbox(payload, mailbox.id, owner.id); await service.setMailboxArea(payload, { area: 'notifications', mailbox: mailbox.id, senderAddress: 'notify-stale@example.test' }, owner.id)
  const make = () => payload.create({ collection: 'notification-outbox', data: { kind: 'new-lead', idempotencyKey: crypto.randomUUID(), state: 'queued', payload: {}, recipientRules: ['owner'], recipients: [{ type: 'staff', id: owner.id, email: owner.email }], channels: ['email'], sourceType: 'inquiry', sourceID: crypto.randomUUID(), availableAt: new Date().toISOString() }, overrideAccess: true })
  for (let index = 0; index < 25; index += 1) { const outbox = await make(); await (payload as any).create({ collection: 'notification-deliveries', data: { outbox: outbox.id, idempotencyKey: `${outbox.id}:staff:${owner.id}:email`, recipient: { type: 'staff', id: owner.id, email: owner.email }, state: 'processing', attempts: 1, nextAttemptAt: new Date().toISOString(), leaseToken: 'crashed', leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() }, overrideAccess: true }) }
  const later = await make(); const before = messages.length
  await expect(dispatchOneNotification(payload)).resolves.toBeNull()
  await expect(dispatchOneNotification(payload)).resolves.toMatchObject({ state: 'delivered' })
  expect(messages).toHaveLength(before + 1)
  expect(await payload.findByID({ collection: 'notification-outbox', id: later.id, overrideAccess: true })).toMatchObject({ state: 'delivered' })
  const unknown = await (payload as any).find({ collection: 'notification-deliveries', where: { failureCode: { equals: 'lease-expired-outcome-unknown' } }, limit: 0, pagination: false, overrideAccess: true }); expect(unknown.totalDocs).toBeGreaterThanOrEqual(25)
})

test('workspace summaries preserve OAuth providers without SMTP connection fields', async () => {
  const oauth = await (payload as any).create({ collection: 'mailbox-configurations', data: { name: 'Google mailbox', provider: 'google', primaryAddress: 'google@example.test', aliases: [], verifiedAliases: [], host: 'oauth', port: 1, security: 'tls', username: 'google@example.test', encryptedCredential: 'opaque', credentialRevision: 'oauth', health: 'connected' }, overrideAccess: true, context: { mailboxInternal: true } })
  const workspace = await service.mailboxWorkspace(payload)
  const publicOAuth = workspace.mailboxes.find((item: { id: string }) => item.id === oauth.id) as Record<string, unknown>
  expect(publicOAuth).toMatchObject({ provider: 'google', primaryAddress: 'google@example.test', credentialConfigured: true })
  expect(publicOAuth).not.toHaveProperty('host')
  expect(publicOAuth).not.toHaveProperty('username')
  expect(workspace.providers.google).toMatchObject({ status: 'connected' })
  expect(workspace.providers.microsoft).toMatchObject({ status: 'available' })
  expect(JSON.stringify(workspace)).not.toContain('opaque')
})

test('OAuth delivery refreshes before a verified Graph send and refuses local draft thread IDs', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'provider-owner@example.test', name: 'Provider owner', roles: ['owner'] }, overrideAccess: true })
  const authorization = new URL(await oauth.startMailboxOAuth(payload, 'microsoft', owner.id, 'provider-session'))
  const state = authorization.searchParams.get('state')!
  const mailbox = await oauth.completeMailboxOAuth(payload, 'microsoft', state, 'provider-code', owner.id, 'provider-session', async (url) => url.includes('/token')
    ? Response.json({ access_token: 'initial-access', refresh_token: 'initial-refresh' })
    : Response.json({ mail: 'provider@example.test' }))
  await service.setMailboxArea(payload, { area: 'leads', mailbox: mailbox.id, senderAddress: 'provider@example.test' }, owner.id)

  let calls = 0
  let drafted: Record<string, unknown> | undefined
  let refreshBody = ''
  const urls: string[] = []
  const fetcher = async (url: string, init: RequestInit) => {
    calls += 1
    urls.push(url)
    if (url.includes('/token')) {
      refreshBody = String(init.body)
      return Response.json({ access_token: 'refreshed-access', refresh_token: 'rotated-refresh' })
    }
    if (url.includes('/v1.0/me?')) return Response.json({ mail: 'provider@example.test' })
    if (url.endsWith('/v1.0/me/messages')) {
      drafted = JSON.parse(String(init.body))
      expect(new Headers(init.headers).get('prefer')).toBe('IdType="ImmutableId"')
      return Response.json({ id: 'graph-draft-id', conversationId: 'graph-conversation-id' })
    }
    if (url.endsWith('/v1.0/me/messages/graph-draft-id/send')) {
      expect(new Headers(init.headers).get('prefer')).toBe('IdType="ImmutableId"')
      return new Response(null, { status: 202 })
    }
    throw new Error(`unexpected provider request ${url}`)
  }

  await expect(service.sendAreaMail(payload, 'leads', { sender: 'provider@example.test', recipient: 'recipient@example.test', subject: 'Approved subject', body: 'Approved plain-text body', threadID: 'local-draft-thread' }, fetcher)).rejects.toThrow('mailbox_thread_not_grounded')
  expect(calls).toBe(0)

  const delivered = await service.sendAreaMail(payload, 'leads', { sender: 'provider@example.test', recipient: 'recipient@example.test', subject: 'Approved subject', body: 'Approved plain-text body', initialOutbound: true }, fetcher)
  expect(delivered).toEqual({ provider: 'microsoft', messageID: 'graph-draft-id', threadID: 'graph-conversation-id' })
  expect(calls).toBe(4)
  expect(refreshBody).toContain('grant_type=refresh_token')
  expect(refreshBody).toContain('refresh_token=initial-refresh')
  expect(drafted).toEqual({ subject: 'Approved subject', body: { contentType: 'Text', content: 'Approved plain-text body' }, toRecipients: [{ emailAddress: { address: 'recipient@example.test' } }], from: { emailAddress: { address: 'provider@example.test' } } })
  const rotated = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true })
  expect(JSON.parse(oauth.decryptMailboxOAuthCredential(String(rotated.encryptedCredential), 'microsoft'))).toEqual({ refreshToken: 'rotated-refresh' })

  await (payload as any).update({ collection: 'mailbox-configurations', id: mailbox.id, data: { aliases: ['alias@example.test'], verifiedAliases: ['alias@example.test'] }, overrideAccess: true, context: { mailboxInternal: true } })
  await service.setMailboxArea(payload, { area: 'leads', mailbox: mailbox.id, senderAddress: 'alias@example.test' }, owner.id)
  let aliasRequests = 0
  await expect(service.sendAreaMail(payload, 'leads', { sender: 'alias@example.test', recipient: 'recipient@example.test', subject: 'Alias', body: 'Body' }, async (url, init) => {
    aliasRequests += 1
    if (url.includes('/token')) return Response.json({ access_token: 'second-access' })
    if (url.includes('/v1.0/me?')) return Response.json({ mail: 'provider@example.test' })
    throw new Error(`send must not run: ${init.method}`)
  })).rejects.toThrow('mailbox_sender_not_verified')
  expect(aliasRequests).toBe(2)
})

test('OAuth Gmail delivery refreshes, verifies the current sender, and does not retry malformed sends', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'gmail-owner@example.test', name: 'Gmail owner', roles: ['owner'] }, overrideAccess: true })
  const authorization = new URL(await oauth.startMailboxOAuth(payload, 'google', owner.id, 'gmail-session'))
  expect(authorization.searchParams.get('scope')).toContain('gmail.settings.basic')
  const state = authorization.searchParams.get('state')!
  const mailbox = await oauth.completeMailboxOAuth(payload, 'google', state, 'provider-code', owner.id, 'gmail-session', async (url) => {
    if (url.includes('/token')) return Response.json({ access_token: 'gmail-initial-access', refresh_token: 'gmail-initial-refresh' })
    if (url.endsWith('/profile')) return Response.json({ emailAddress: 'gmail@example.test' })
    if (url.endsWith('/settings/sendAs')) return Response.json({ sendAs: [{ sendAsEmail: 'gmail@example.test', verificationStatus: 'accepted' }, { sendAsEmail: 'gmail-alias@example.test', verificationStatus: 'accepted' }, { sendAsEmail: 'unverified@example.test', verificationStatus: 'pending' }] })
    throw new Error(`unexpected setup request ${url}`)
  })
  expect(mailbox).toMatchObject({ aliases: ['gmail-alias@example.test'], verifiedAliases: ['gmail-alias@example.test'] })
  await service.setMailboxArea(payload, { area: 'careers', mailbox: mailbox.id, senderAddress: 'gmail@example.test' }, owner.id)
  await expect(service.setMailboxArea(payload, { area: 'careers', mailbox: mailbox.id, senderAddress: 'unverified@example.test' }, owner.id)).rejects.toThrow('not been verified')

  let sends = 0
  let sent: Record<string, unknown> | undefined
  const fetcher = async (url: string, init: RequestInit) => {
    if (url.includes('/token')) return Response.json({ access_token: 'gmail-refreshed-access', refresh_token: 'gmail-rotated-refresh' })
    if (url.endsWith('/profile')) return Response.json({ emailAddress: 'gmail@example.test' })
    if (url.endsWith('/settings/sendAs')) return Response.json({ sendAs: [{ sendAsEmail: 'gmail@example.test', verificationStatus: 'accepted' }, { sendAsEmail: 'gmail-alias@example.test', verificationStatus: 'accepted' }] })
    if (url.endsWith('/messages/send')) {
      sends += 1
      sent = JSON.parse(String(init.body))
      return Response.json({ id: 'gmail-message-id', threadId: 'gmail-thread-id' })
    }
    throw new Error(`unexpected delivery request ${url}`)
  }
  await expect(service.sendAreaMail(payload, 'careers', { sender: 'gmail@example.test', recipient: 'recipient@example.test', subject: 'Gmail subject', body: 'Gmail plain-text body' }, fetcher)).resolves.toEqual({ provider: 'google', messageID: 'gmail-message-id' })
  expect(sends).toBe(1)
  expect(Buffer.from(String(sent?.raw), 'base64url').toString('utf8')).toBe('To: recipient@example.test\r\nFrom: gmail@example.test\r\nSubject: Gmail subject\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nGmail plain-text body')
  const rotated = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true })
  expect(JSON.parse(oauth.decryptMailboxOAuthCredential(String(rotated.encryptedCredential), 'google'))).toEqual({ refreshToken: 'gmail-rotated-refresh' })

  await service.setMailboxArea(payload, { area: 'careers', mailbox: mailbox.id, senderAddress: 'gmail-alias@example.test' }, owner.id)
  let aliasSent: Record<string, unknown> | undefined
  await expect(service.sendAreaMail(payload, 'careers', { sender: 'gmail-alias@example.test', recipient: 'recipient@example.test', subject: 'Alias', body: 'Alias body' }, async (url, init) => {
    if (url.includes('/token')) return Response.json({ access_token: 'gmail-alias-access' })
    if (url.endsWith('/profile')) return Response.json({ emailAddress: 'gmail@example.test' })
    if (url.endsWith('/settings/sendAs')) return Response.json({ sendAs: [{ sendAsEmail: 'gmail-alias@example.test', verificationStatus: 'accepted' }] })
    if (url.endsWith('/messages/send')) { aliasSent = JSON.parse(String(init.body)); return Response.json({ id: 'gmail-alias-message', threadId: 'gmail-alias-thread' }) }
    throw new Error(`unexpected alias request ${url}`)
  })).resolves.toEqual({ provider: 'google', messageID: 'gmail-alias-message' })
  expect(Buffer.from(String(aliasSent?.raw), 'base64url').toString('utf8')).toContain('From: gmail-alias@example.test')
  await service.setMailboxArea(payload, { area: 'careers', mailbox: mailbox.id, senderAddress: 'gmail@example.test' }, owner.id)

  let malformedSends = 0
  await expect(service.sendAreaMail(payload, 'careers', { sender: 'gmail@example.test', recipient: 'recipient@example.test', subject: 'Malformed', body: 'No retry' }, async (url) => {
    if (url.includes('/token')) return Response.json({ access_token: 'gmail-next-access' })
    if (url.endsWith('/profile')) return Response.json({ emailAddress: 'gmail@example.test' })
    if (url.endsWith('/settings/sendAs')) return Response.json({ sendAs: [{ sendAsEmail: 'gmail@example.test', verificationStatus: 'accepted' }] })
    if (url.endsWith('/messages/send')) { malformedSends += 1; return Response.json({}) }
    throw new Error(`unexpected malformed request ${url}`)
  })).rejects.toThrow('provider_malformed_response')
  expect(malformedSends).toBe(1)

  let changedSenderRequests = 0
  await expect(service.sendAreaMail(payload, 'careers', { sender: 'gmail@example.test', recipient: 'recipient@example.test', subject: 'Changed', body: 'Refuse' }, async (url) => {
    changedSenderRequests += 1
    if (url.includes('/token')) return Response.json({ access_token: 'gmail-changed-access' })
    if (url.endsWith('/profile')) return Response.json({ emailAddress: 'changed@example.test' })
    if (url.endsWith('/settings/sendAs')) return Response.json({ sendAs: [] })
    throw new Error(`provider send must not run: ${url}`)
  })).rejects.toThrow('mailbox_sender_not_verified')
  expect(changedSenderRequests).toBe(3)
})

test('OAuth delivery rechecks mapping, health, and credentials after identity before sending', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'outbound-boundary-owner@example.test', name: 'Outbound boundary', roles: ['owner'] }, overrideAccess: true })
  const state = new URL(await oauth.startMailboxOAuth(payload, 'microsoft', owner.id, 'outbound-boundary-session')).searchParams.get('state')!
  const mailbox = await oauth.completeMailboxOAuth(payload, 'microsoft', state, 'code', owner.id, 'outbound-boundary-session', async (url) => url.includes('/token') ? Response.json({ access_token: 'setup', refresh_token: 'refresh' }) : Response.json({ mail: 'boundary@example.test' }))
  const replacement = await (payload as any).create({ collection: 'mailbox-configurations', data: { name: 'Replacement', provider: 'smtp', primaryAddress: 'replacement@example.test', aliases: [], verifiedAliases: [], host: 'smtp.example.test', port: 587, security: 'starttls', username: 'replacement@example.test', encryptedCredential: 'opaque', credentialRevision: 'replacement', health: 'connected' }, overrideAccess: true, context: { mailboxInternal: true } })
  await service.setMailboxArea(payload, { area: 'leads', mailbox: mailbox.id, senderAddress: 'boundary@example.test' }, owner.id)
  const mapping = (await payload.find({ collection: 'mailbox-area-mappings', where: { area: { equals: 'leads' } }, limit: 1, overrideAccess: true })).docs[0]
  for (const change of ['remap', 'revoke', 'credential'] as const) {
    await (payload as any).update({ collection: 'mailbox-area-mappings', id: mapping.id, data: { mailbox: mailbox.id, senderAddress: 'boundary@example.test' }, overrideAccess: true, context: { mailboxInternal: true } })
    await (payload as any).update({ collection: 'mailbox-configurations', id: mailbox.id, data: { health: 'connected', credentialRevision: `boundary-${change}` }, overrideAccess: true, context: { mailboxInternal: true } })
    let sends = 0
    await expect(service.sendAreaMail(payload, 'leads', { sender: 'boundary@example.test', recipient: 'recipient@example.test', subject: 'Boundary', body: 'Reviewed' }, async (url) => {
      if (url.includes('/token')) return Response.json({ access_token: `${change}-access` })
      if (url.includes('/v1.0/me?')) {
        if (change === 'remap') await (payload as any).update({ collection: 'mailbox-area-mappings', id: mapping.id, data: { mailbox: replacement.id, senderAddress: 'replacement@example.test' }, overrideAccess: true, context: { mailboxInternal: true } })
        if (change === 'revoke') await (payload as any).update({ collection: 'mailbox-configurations', id: mailbox.id, data: { health: 'unavailable' }, overrideAccess: true, context: { mailboxInternal: true } })
        if (change === 'credential') await (payload as any).update({ collection: 'mailbox-configurations', id: mailbox.id, data: { credentialRevision: 'replaced-during-identity' }, overrideAccess: true, context: { mailboxInternal: true } })
        return Response.json({ mail: 'boundary@example.test' })
      }
      if (url.endsWith('/sendMail')) { sends += 1; return new Response(null, { status: 202 }) }
      throw new Error(`unexpected request ${url}`)
    })).rejects.toThrow('mailbox_not_ready')
    expect(sends).toBe(0)
  }
})

test('a provider reply thread cannot cross the mailbox or its target binding', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'thread-bound-owner@example.test', name: 'Thread boundary', roles: ['owner'] }, overrideAccess: true })
  const createMailbox = (name: string, address: string) => (payload as any).create({ collection: 'mailbox-configurations', data: { name, provider: 'google', primaryAddress: address, aliases: [], verifiedAliases: [], host: 'oauth', port: 1, security: 'tls', username: address, encryptedCredential: 'opaque', credentialRevision: name, health: 'connected' }, overrideAccess: true, context: { mailboxInternal: true } })
  const first = await createMailbox('Thread first', 'thread-first@example.test')
  const second = await createMailbox('Thread second', 'thread-second@example.test')
  await service.setMailboxArea(payload, { area: 'leads', mailbox: second.id, senderAddress: 'thread-second@example.test' }, owner.id)
  const lead = await payload.create({ collection: 'inquiries', data: { email: 'thread-bound-lead@example.test', message: 'Thread binding', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: crypto.randomUUID(), stage: 'new' }, overrideAccess: true })
  const thread = await payload.create({ collection: 'mail-threads', data: { lead: lead.id, mailbox: first.id, provider: 'google', providerConversationID: 'provider-thread' }, overrideAccess: true })
  await payload.create({ collection: 'mail-thread-messages', data: { thread: thread.id, mailbox: first.id, lead: lead.id, providerMessageID: 'provider-message', direction: 'inbound', sender: lead.email, recipient: 'thread-first@example.test', subject: 'Original', body: 'Original', receivedAt: new Date().toISOString(), attachmentMetadata: [] }, overrideAccess: true })
  let calls = 0
  await expect(service.sendAreaMail(payload, 'leads', { sender: 'thread-second@example.test', recipient: lead.email, subject: 'Reviewed', body: 'Exact approved content', threadID: 'local-draft-thread', providerThreadID: 'provider-thread', providerMessageID: 'provider-message', providerMailboxID: first.id, provider: 'google', providerTarget: { collection: 'inquiries', id: lead.id } }, async () => { calls += 1; return Response.json({}) })).rejects.toThrow('mailbox_thread_not_grounded')
  expect(calls).toBe(0)
})
