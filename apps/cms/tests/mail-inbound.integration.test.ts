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
  await expect(appendMatchedInbound(payload, { ...input, conversationID: 'different-conversation', messageID: 'message-2' })).resolves.toEqual({ matched: false, suggested: false })
  await expect(appendMatchedInbound(payload, { ...input, conversationID: 'unrelated-conversation', messageID: 'message-3', sender: 'unrelated@example.test' })).resolves.toEqual({ matched: false, suggested: false })
  const messages = await payload.find({ collection: 'mail-thread-messages', depth: 0, overrideAccess: true })
  expect(messages.docs).toHaveLength(1)
  expect(JSON.stringify(messages.docs[0])).not.toContain('different-conversation')
})

test('Sales and Hiring read only their own mail target type, and duplicate arrivals are idempotent', async () => {
  const sales = await payload.create({ collection: 'users', data: { email: 'inbound-sales@example.test', name: 'Sales', roles: ['sales'] }, overrideAccess: true })
  const hiring = await payload.create({ collection: 'users', data: { email: 'inbound-hiring@example.test', name: 'Hiring', roles: ['hiring'] }, overrideAccess: true })
  const lead = await payload.create({ collection: 'inquiries', data: { email: 'lead-scope@example.test', message: 'lead', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'mail-inbound-lead-0002', stage: 'new' }, overrideAccess: true })
  const application = await payload.create({ collection: 'applications', data: { name: 'Applicant', email: 'application-scope@example.test', coverLetter: 'Application body', consent: true, jobId: crypto.randomUUID(), resumeKey: 'resume', idempotencyKey: crypto.randomUUID(), status: 'new' }, overrideAccess: true })
  const mailbox = await payload.create({ collection: 'mailbox-configurations', data: { name: 'Scope inbound', provider: 'smtp', primaryAddress: 'staff2@example.test', aliases: [], verifiedAliases: [], host: 'smtp.example.test', port: 587, security: 'starttls', username: 'staff', encryptedCredential: 'opaque', credentialRevision: 'test', health: 'connected' }, overrideAccess: true, context: { mailboxInternal: true } })
  const leadThread = await payload.create({ collection: 'mail-threads', data: { lead: lead.id, mailbox: mailbox.id, provider: 'microsoft', providerConversationID: 'lead-conversation' }, overrideAccess: true })
  await payload.create({ collection: 'mail-threads', data: { application: application.id, mailbox: mailbox.id, provider: 'microsoft', providerConversationID: 'application-conversation' }, overrideAccess: true })
  const inbound = { mailbox: mailbox.id, provider: 'microsoft' as const, conversationID: 'lead-conversation', messageID: 'concurrent-message', sender: 'lead-scope@example.test', recipient: 'staff2@example.test', subject: 'reply', body: 'body', receivedAt: '2026-10-05T00:00:00Z' }
  const arrivals = await Promise.all([appendMatchedInbound(payload, inbound), appendMatchedInbound(payload, inbound)])
  expect(arrivals.map((arrival) => arrival.matched)).toEqual([true, true])
  expect(arrivals.map((arrival) => arrival.matched && arrival.duplicate)).toEqual([false, false])
  expect((await payload.find({ collection: 'mail-thread-messages', where: { providerMessageID: { equals: inbound.messageID } }, overrideAccess: true })).docs).toHaveLength(1)
  const salesMessages = await payload.find({ collection: 'mail-thread-messages', user: sales, depth: 0, overrideAccess: false })
  const hiringMessages = await payload.find({ collection: 'mail-thread-messages', user: hiring, depth: 0, overrideAccess: false })
  expect(salesMessages.docs.some((message) => message.thread === leadThread.id)).toBe(true)
  expect(hiringMessages.docs.some((message) => message.thread === leadThread.id)).toBe(false)
  const salesThreads = await payload.find({ collection: 'mail-threads', user: sales, depth: 0, overrideAccess: false })
  const hiringThreads = await payload.find({ collection: 'mail-threads', user: hiring, depth: 0, overrideAccess: false })
  expect(salesThreads.docs.some((thread) => thread.application)).toBe(false)
  expect(hiringThreads.docs.some((thread) => thread.lead)).toBe(false)
  const union = await payload.create({ collection: 'users', data: { email: 'inbound-union@example.test', name: 'Union', roles: ['sales', 'hiring'] }, overrideAccess: true })
  const unionThreads = await payload.find({ collection: 'mail-threads', user: union, depth: 0, overrideAccess: false })
  expect(unionThreads.docs.some((thread) => thread.lead)).toBe(true)
  expect(unionThreads.docs.some((thread) => thread.application)).toBe(true)
})

test('unmatched suggestions follow the mapped area and concurrent conversation arrivals coalesce', async () => {
  const email = `shared-${crypto.randomUUID()}@example.test`
  const lead = await payload.create({ collection: 'inquiries', data: { email, message: 'lead', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: crypto.randomUUID(), stage: 'new' }, overrideAccess: true })
  await payload.create({ collection: 'applications', data: { name: 'Same address', email, coverLetter: 'application', consent: true, jobId: crypto.randomUUID(), resumeKey: 'resume-shared', idempotencyKey: crypto.randomUUID(), status: 'new' }, overrideAccess: true })
  const mailbox = async (name: string) => payload.create({ collection: 'mailbox-configurations', data: { name, provider: 'smtp', primaryAddress: `${name}@example.test`, aliases: [], verifiedAliases: [], host: 'smtp.example.test', port: 587, security: 'starttls', username: name, encryptedCredential: 'opaque', credentialRevision: 'test', health: 'connected' }, overrideAccess: true, context: { mailboxInternal: true } })
  const leads = await mailbox('area-leads'); const careers = await mailbox('area-careers')
  await payload.create({ collection: 'mailbox-area-mappings', data: { area: 'leads', mailbox: leads.id, senderAddress: leads.primaryAddress }, overrideAccess: true, context: { mailboxInternal: true } })
  await payload.create({ collection: 'mailbox-area-mappings', data: { area: 'careers', mailbox: careers.id, senderAddress: careers.primaryAddress }, overrideAccess: true, context: { mailboxInternal: true } })
  const input = (mailbox: string, conversationID: string, messageID: string) => ({ mailbox, provider: 'google' as const, conversationID, messageID, sender: email, recipient: 'staff@example.test', subject: 'unmatched', body: 'never stored', receivedAt: '2026-10-05T00:00:00Z' })
  await expect(appendMatchedInbound(payload, input(careers.id, 'career-conversation', 'career-message'))).resolves.toEqual({ matched: false, suggested: true })
  await expect(appendMatchedInbound(payload, input(leads.id, 'lead-conversation-race', 'lead-message-a'))).resolves.toEqual({ matched: false, suggested: true })
  await expect(appendMatchedInbound(payload, input(leads.id, 'lead-conversation-race', 'lead-message-b'))).resolves.toEqual({ matched: false, suggested: true })
  const suggestions = await payload.find({ collection: 'mail-conversation-suggestions', limit: 20, depth: 0, overrideAccess: true })
  expect(suggestions.docs.filter((item) => item.providerConversationID === 'career-conversation').map((item) => item.target)).toEqual(['application'])
  expect(suggestions.docs.filter((item) => item.providerConversationID === 'lead-conversation-race').map((item) => item.target)).toEqual(['lead'])
  expect(lead.id).toBeTruthy()
})
