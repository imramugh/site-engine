import { afterAll, beforeAll, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPayload } from 'payload'

const directory = mkdtempSync(join(tmpdir(), 'mailbox-inbound-sync-'))
Object.assign(process.env, { DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`, PAYLOAD_SECRET: 'mailbox-inbound-sync-test-secret', PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.example.test', INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64url'), MAILBOX_MICROSOFT_CLIENT_ID: 'client', MAILBOX_MICROSOFT_CLIENT_SECRET: 'secret', MAILBOX_GOOGLE_CLIENT_ID: 'google-client', MAILBOX_GOOGLE_CLIENT_SECRET: 'google-secret' })
const { default: config } = await import('../payload.config.js')
const { startMailboxOAuth, completeMailboxOAuth } = await import('../src/mailbox-oauth.js')
const { syncMailboxInbound } = await import('../src/mailbox-inbound-sync.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload.destroy(); rmSync(directory, { recursive: true, force: true }) })

test('a partial Graph page does not advance its durable cursor and safely replays on restart', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'sync-owner@example.test', name: 'Sync owner', roles: ['owner'] }, overrideAccess: true })
  const state = new URL(await startMailboxOAuth(payload, 'microsoft', owner.id, 'sync-session')).searchParams.get('state')!
  const mailbox = await completeMailboxOAuth(payload, 'microsoft', state, 'code', owner.id, 'sync-session', async (url) => url.includes('/token') ? Response.json({ access_token: 'setup-access', refresh_token: 'refresh' }) : Response.json({ mail: 'sync@example.test' }))
  const lead = await (payload as any).create({ collection: 'inquiries', data: { email: 'visitor@example.test', message: 'Original', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'sync-lead' }, overrideAccess: true })
  await payload.create({ collection: 'mail-threads', data: { lead: lead.id, mailbox: mailbox.id, provider: 'microsoft', providerConversationID: 'conversation-1' }, overrideAccess: true })
  const graph = (invalid = false) => async (url: string) => {
    if (url.includes('/token')) return Response.json({ access_token: 'sync-access' })
    if (url.includes('/delta')) return Response.json({ value: [
      { id: 'message-1', conversationId: 'conversation-1', from: { emailAddress: { address: 'visitor@example.test' } }, toRecipients: [{ emailAddress: { address: 'sync@example.test' } }], subject: 'One', body: { content: 'One' }, receivedDateTime: '2026-10-06T00:00:00Z' },
      { id: 'message-2', conversationId: 'conversation-1', from: { emailAddress: { address: invalid ? 'not-an-email' : 'visitor@example.test' } }, toRecipients: [{ emailAddress: { address: 'sync@example.test' } }], subject: 'Two', body: { content: 'Two' }, receivedDateTime: '2026-10-06T00:01:00Z' },
    ], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=next' })
    throw new Error(`unexpected ${url}`)
  }
  await expect(syncMailboxInbound(payload, mailbox.id, graph(true))).rejects.toThrow('invalid_inbound_message')
  let stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(stored.inboundCursor).toBeNull()
  expect((await payload.find({ collection: 'mail-thread-messages', overrideAccess: true })).docs).toHaveLength(1)
  await expect(syncMailboxInbound(payload, mailbox.id, graph(false))).resolves.toMatchObject({ skipped: false, processed: 2 })
  stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(stored.inboundCursor).toContain('deltatoken=next')
  expect((await payload.find({ collection: 'mail-thread-messages', overrideAccess: true })).docs).toHaveLength(2)
})

test('a disconnected or revised mailbox cannot append a polled message or advance its cursor', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'sync-race@example.test', name: 'Sync race', roles: ['owner'] }, overrideAccess: true })
  const state = new URL(await startMailboxOAuth(payload, 'microsoft', owner.id, 'sync-race-session')).searchParams.get('state')!
  const mailbox = await completeMailboxOAuth(payload, 'microsoft', state, 'code', owner.id, 'sync-race-session', async (url) => url.includes('/token') ? Response.json({ access_token: 'setup-access', refresh_token: 'refresh' }) : Response.json({ mail: 'sync-race@example.test' }))
  const fetcher = async (url: string) => {
    if (url.includes('/token')) return Response.json({ access_token: 'sync-access' })
    if (url.includes('/delta')) {
      await (payload as any).update({ collection: 'mailbox-configurations', id: mailbox.id, data: { health: 'unavailable', credentialRevision: 'changed-revision' }, overrideAccess: true, context: { mailboxInternal: true } })
      return Response.json({ value: [{ id: 'race-message', conversationId: 'race-conversation', from: { emailAddress: { address: 'visitor@example.test' } }, toRecipients: [{ emailAddress: { address: 'sync-race@example.test' } }], subject: 'Race', body: { content: 'Race' }, receivedDateTime: '2026-10-06T00:00:00Z' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=race' })
    }
    throw new Error(`unexpected ${url}`)
  }
  await expect(syncMailboxInbound(payload, mailbox.id, fetcher)).rejects.toThrow('mailbox_configuration_changed')
  const stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(stored.inboundCursor).toBeNull()
  expect((await payload.find({ collection: 'mail-thread-messages', where: { providerMessageID: { equals: 'race-message' } }, overrideAccess: true })).docs).toHaveLength(0)
})

test('provider conversations and duplicate message IDs remain isolated by mailbox', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'sync-isolation@example.test', name: 'Sync isolation', roles: ['owner'] }, overrideAccess: true })
  const connect = async (session: string, address: string) => {
    const state = new URL(await startMailboxOAuth(payload, 'microsoft', owner.id, session)).searchParams.get('state')!
    return completeMailboxOAuth(payload, 'microsoft', state, 'code', owner.id, session, async (url) => url.includes('/token') ? Response.json({ access_token: 'setup-access', refresh_token: `refresh-${session}` }) : Response.json({ mail: address }))
  }
  const first = await connect('isolation-a', 'isolation-a@example.test')
  const second = await connect('isolation-b', 'isolation-b@example.test')
  const firstLead = await (payload as any).create({ collection: 'inquiries', data: { email: 'matched@example.test', message: 'First', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'isolation-first' }, overrideAccess: true })
  const secondLead = await (payload as any).create({ collection: 'inquiries', data: { email: 'other@example.test', message: 'Second', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'isolation-second' }, overrideAccess: true })
  const firstThread = await payload.create({ collection: 'mail-threads', data: { lead: firstLead.id, mailbox: first.id, provider: 'microsoft', providerConversationID: 'shared-conversation' }, overrideAccess: true })
  const secondThread = await payload.create({ collection: 'mail-threads', data: { lead: secondLead.id, mailbox: second.id, provider: 'microsoft', providerConversationID: 'shared-conversation' }, overrideAccess: true })
  const page = (conversationID = 'shared-conversation', messageID = 'shared-message') => async (url: string) => {
    if (url.includes('/token')) return Response.json({ access_token: 'sync-access' })
    if (url.includes('/delta')) return Response.json({ value: [{ id: messageID, conversationId: conversationID, from: { emailAddress: { address: 'matched@example.test' } }, toRecipients: [{ emailAddress: { address: 'staff@example.test' } }], subject: 'Scoped', body: { content: 'Scoped' }, receivedDateTime: '2026-10-06T00:00:00Z' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=scoped' })
    throw new Error(`unexpected ${url}`)
  }
  await syncMailboxInbound(payload, first.id, page())
  await syncMailboxInbound(payload, second.id, page())
  const messages = await payload.find({ collection: 'mail-thread-messages', where: { providerMessageID: { equals: 'shared-message' } }, overrideAccess: true })
  expect(messages.docs).toHaveLength(2)
  expect(messages.docs.map((message) => typeof message.thread === 'string' ? message.thread : message.thread.id).sort()).toEqual([firstThread.id, secondThread.id].sort())
  await syncMailboxInbound(payload, first.id, page('unrelated-conversation', 'unmatched-message'))
  expect((await payload.find({ collection: 'mail-thread-messages', where: { providerMessageID: { equals: 'unmatched-message' } }, overrideAccess: true })).docs).toHaveLength(0)
})

test('Gmail history hydrates a matched MIME message before advancing its durable cursor', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'gmail-sync@example.test', name: 'Gmail sync', roles: ['owner'] }, overrideAccess: true })
  const state = new URL(await startMailboxOAuth(payload, 'google', owner.id, 'gmail-sync-session')).searchParams.get('state')!
  const mailbox = await completeMailboxOAuth(payload, 'google', state, 'code', owner.id, 'gmail-sync-session', async (url) => url.includes('/token') ? Response.json({ access_token: 'setup', refresh_token: 'refresh' }) : url.endsWith('/profile') ? Response.json({ emailAddress: 'gmail-sync@example.test', historyId: '100' }) : Response.json({ sendAs: [{ sendAsEmail: 'gmail-sync@example.test', verificationStatus: 'accepted' }] }))
  const lead = await (payload as any).create({ collection: 'inquiries', data: { email: 'gmail-visitor@example.test', message: 'Original', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'gmail-sync-lead' }, overrideAccess: true })
  await payload.create({ collection: 'mail-threads', data: { lead: lead.id, mailbox: mailbox.id, provider: 'google', providerConversationID: 'gmail-thread' }, overrideAccess: true })
  let phase: 'seed' | 'hydrate' | 'malformed' = 'seed'
  const fetcher = async (url: string) => {
    if (url.includes('/token')) return Response.json({ access_token: 'gmail-access' })
    if (url.endsWith('/profile')) return Response.json({ emailAddress: 'gmail-sync@example.test', historyId: '100' })
    if (url.endsWith('/settings/sendAs')) return Response.json({ sendAs: [{ sendAsEmail: 'gmail-sync@example.test', verificationStatus: 'accepted' }] })
    if (url.includes('/history?')) return Response.json(phase === 'malformed' ? { historyId: '102', history: [{ messagesAdded: [{ message: { id: 'bad-message' } }] }] } : { historyId: '101', history: [{ messagesAdded: [{ message: { id: 'gmail-message' } }] }] })
    if (url.includes('/messages/gmail-message?')) return Response.json({ id: 'gmail-message', threadId: 'gmail-thread', internalDate: '1791244800000', payload: { headers: [{ name: 'From', value: 'gmail-visitor@example.test' }, { name: 'To', value: 'gmail-sync@example.test' }, { name: 'Subject', value: '<b>Safe reply</b>' }], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('<p>Hello</p>\u0000', 'utf8').toString('base64url') } }, { filename: '<b>resume.pdf</b>', mimeType: 'application/pdf', body: { attachmentId: 'a', size: 42 } }] } })
    if (url.includes('/messages/bad-message?')) return Response.json({ id: 'bad-message', threadId: '' })
    throw new Error(`unexpected ${url}`)
  }
  await syncMailboxInbound(payload, mailbox.id, fetcher)
  let stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(JSON.parse(stored.inboundCursor)).toEqual({ historyID: '100' })
  phase = 'hydrate'
  await expect(syncMailboxInbound(payload, mailbox.id, fetcher)).resolves.toMatchObject({ processed: 1 })
  stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(JSON.parse(stored.inboundCursor)).toEqual({ historyID: '101' })
  const message = (await payload.find({ collection: 'mail-thread-messages', where: { providerMessageID: { equals: 'gmail-message' } }, overrideAccess: true })).docs[0] as any
  expect(message).toMatchObject({ subject: 'Safe reply', body: 'Hello', attachmentMetadata: [{ name: 'resume.pdf', contentType: 'application/pdf', size: 42 }] })
  phase = 'malformed'
  await expect(syncMailboxInbound(payload, mailbox.id, fetcher)).rejects.toThrow('provider_malformed_response')
  stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(JSON.parse(stored.inboundCursor)).toEqual({ historyID: '101' })
})
