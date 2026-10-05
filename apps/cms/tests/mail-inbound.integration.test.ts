import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPayload } from 'payload'

const directory = mkdtempSync(join(tmpdir(), 'mail-inbound-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'mail-inbound-test-secret-long-enough'
const { default: config } = await import('../payload.config.js')
const { appendMatchedInbound } = await import('../src/mail-inbound.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload.destroy(); rmSync(directory, { recursive: true, force: true }); delete process.env.DATABASE_URI; delete process.env.PAYLOAD_SECRET })

test('inbound mail attaches only to the existing mailbox-scoped provider conversation', async () => {
  const lead = await payload.create({ collection: 'inquiries', data: { email: 'visitor@example.test', message: 'Original inquiry', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'mail-inbound-lead-0001', stage: 'new' }, overrideAccess: true })
  const mailbox = await payload.create({ collection: 'mailbox-configurations', data: { name: 'Inbound', provider: 'smtp', primaryAddress: 'staff@example.test', aliases: [], verifiedAliases: [], host: 'smtp.example.test', port: 587, security: 'starttls', username: 'staff', encryptedCredential: 'opaque', credentialRevision: 'test', health: 'connected' }, overrideAccess: true, context: { mailboxInternal: true } })
  const thread = await payload.create({ collection: 'mail-threads', data: { lead: lead.id, mailbox: mailbox.id, provider: 'microsoft', providerConversationID: 'conversation-1' }, overrideAccess: true })
  const input = { mailbox: mailbox.id, provider: 'microsoft' as const, conversationID: 'conversation=1+/opaque', messageID: 'message=1+/opaque', sender: 'visitor@example.test', recipient: 'staff@example.test', subject: '<b>Reply</b>', body: '<p>Hello</p>\u0000', receivedAt: '2026-10-05T00:00:00Z', attachmentMetadata: [{ name: '<b>resume.pdf</b>', contentType: 'application/pdf', size: 123 }] }
  await payload.update({ collection: 'mail-threads', id: thread.id, data: { providerConversationID: input.conversationID }, overrideAccess: true })
  await expect(appendMatchedInbound(payload, input)).resolves.toMatchObject({ matched: true, duplicate: false, message: { thread: thread.id, subject: 'Reply', body: 'Hello' } })
  await expect(appendMatchedInbound(payload, input)).resolves.toMatchObject({ matched: true, duplicate: true })
  await expect(appendMatchedInbound(payload, { ...input, conversationID: 'different-conversation', messageID: 'message-2' })).resolves.toEqual({ matched: false, suggested: true })
  await expect(appendMatchedInbound(payload, { ...input, conversationID: 'unrelated-conversation', messageID: 'message-3', sender: 'unrelated@example.test' })).resolves.toEqual({ matched: false, suggested: false })
  const messages = await payload.find({ collection: 'mail-thread-messages', depth: 0, overrideAccess: true })
  expect(messages.docs).toHaveLength(1)
  expect(JSON.stringify(messages.docs[0])).not.toContain('different-conversation')
})
