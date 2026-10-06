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

test('an aborted provider poll stops before it appends or advances a cursor', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'sync-abort@example.test', name: 'Sync abort', roles: ['owner'] }, overrideAccess: true })
  const state = new URL(await startMailboxOAuth(payload, 'microsoft', owner.id, 'sync-abort-session')).searchParams.get('state')!
  const mailbox = await completeMailboxOAuth(payload, 'microsoft', state, 'code', owner.id, 'sync-abort-session', async (url) => url.includes('/token') ? Response.json({ access_token: 'setup-access', refresh_token: 'refresh' }) : Response.json({ mail: 'sync-abort@example.test' }))
  const controller = new AbortController()
  await expect(syncMailboxInbound(payload, mailbox.id, async (url) => {
    if (url.includes('/token')) return Response.json({ access_token: 'sync-access' })
    if (url.includes('/delta')) { controller.abort(); return Response.json({ value: [{ id: 'aborted-message', conversationId: 'aborted-thread', from: { emailAddress: { address: 'visitor@example.test' } }, toRecipients: [{ emailAddress: { address: 'sync-abort@example.test' } }], subject: 'Abort', body: { content: 'Abort' }, receivedDateTime: '2026-10-06T00:00:00Z' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=aborted' }) }
    throw new Error(`unexpected ${url}`)
  }, controller.signal)).rejects.toThrow('sync_aborted')
  const stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(stored.inboundCursor).toBeNull()
  expect((await payload.find({ collection: 'mail-thread-messages', where: { providerMessageID: { equals: 'aborted-message' } }, overrideAccess: true })).docs).toHaveLength(0)
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
    if (url.includes('/messages/gmail-message?')) return Response.json({ id: 'gmail-message', threadId: 'gmail-thread', internalDate: '1791244800000', payload: { headers: [{ name: 'From', value: 'gmail-visitor@example.test' }, { name: 'To', value: 'gmail-sync@example.test' }, { name: 'Subject', value: '<b>Safe reply</b>' }, { name: 'Message-ID', value: '<gmail-original@example.test>' }, { name: 'References', value: '<root@example.test>' }], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('<p>Hello</p>\u0000', 'utf8').toString('base64url') } }, { filename: '<b>resume.pdf</b>', mimeType: 'application/pdf', body: { attachmentId: 'a', size: 42 } }] } })
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
  expect(message).toMatchObject({ subject: 'Safe reply', body: 'Hello', rfcMessageID: '<gmail-original@example.test>', rfcReferences: '<root@example.test>', attachmentMetadata: [{ name: 'resume.pdf', contentType: 'application/pdf', size: 42 }] })
  phase = 'malformed'
  await expect(syncMailboxInbound(payload, mailbox.id, fetcher)).rejects.toThrow('provider_malformed_response')
  stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(JSON.parse(stored.inboundCursor)).toEqual({ historyID: '101' })
})

test('Gmail keeps its original start history ID through every history page', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'gmail-pages@example.test', name: 'Gmail pages', roles: ['owner'] }, overrideAccess: true })
  const state = new URL(await startMailboxOAuth(payload, 'google', owner.id, 'gmail-pages-session')).searchParams.get('state')!
  const mailbox = await completeMailboxOAuth(payload, 'google', state, 'code', owner.id, 'gmail-pages-session', async (url) => url.includes('/token') ? Response.json({ access_token: 'setup-access', refresh_token: 'refresh' }) : url.endsWith('/profile') ? Response.json({ emailAddress: 'gmail-pages@example.test', historyId: '100' }) : Response.json({ sendAs: [{ sendAsEmail: 'gmail-pages@example.test', verificationStatus: 'accepted' }] }))
  await (payload as any).update({ collection: 'mailbox-configurations', id: mailbox.id, data: { inboundCursor: JSON.stringify({ historyID: '100' }), inboundCursorRevision: mailbox.credentialRevision }, overrideAccess: true, context: { mailboxInternal: true } })
  const fetcher = async (url: string) => {
    if (url.includes('/token')) return Response.json({ access_token: 'gmail-access' })
    if (url.includes('/history?')) return Response.json(url.includes('pageToken=second-page') ? { historyId: '102', history: [{ messagesAdded: [{ message: { id: 'second-message' } }] }] } : { historyId: '101', nextPageToken: 'second-page', history: [{ messagesAdded: [{ message: { id: 'first-message' } }] }] })
    const id = url.includes('/messages/first-message?') ? 'first-message' : url.includes('/messages/second-message?') ? 'second-message' : undefined
    if (id) return Response.json({ id, threadId: 'gmail-pages-thread', internalDate: '1791244800000', payload: { headers: [{ name: 'From', value: 'unmatched-pages@example.test' }, { name: 'To', value: 'gmail-pages@example.test' }, { name: 'Subject', value: id }], body: { data: Buffer.from(id).toString('base64url') } } })
    throw new Error(`unexpected ${url}`)
  }
  await expect(syncMailboxInbound(payload, mailbox.id, fetcher)).resolves.toMatchObject({ processed: 1 })
  let stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(JSON.parse(stored.inboundCursor)).toEqual({ historyID: '100', pageToken: 'second-page' })
  await expect(syncMailboxInbound(payload, mailbox.id, fetcher)).resolves.toMatchObject({ processed: 1 })
  stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(JSON.parse(stored.inboundCursor)).toEqual({ historyID: '102' })
})

test('Gmail refuses an oversized history page without advancing its cursor', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'gmail-large@example.test', name: 'Gmail large', roles: ['owner'] }, overrideAccess: true })
  const state = new URL(await startMailboxOAuth(payload, 'google', owner.id, 'gmail-large-session')).searchParams.get('state')!
  const mailbox = await completeMailboxOAuth(payload, 'google', state, 'code', owner.id, 'gmail-large-session', async (url) => url.includes('/token') ? Response.json({ access_token: 'setup-access', refresh_token: 'refresh' }) : url.endsWith('/profile') ? Response.json({ emailAddress: 'gmail-large@example.test', historyId: '100' }) : Response.json({ sendAs: [{ sendAsEmail: 'gmail-large@example.test', verificationStatus: 'accepted' }] }))
  const originalCursor = JSON.stringify({ historyID: '100' })
  await (payload as any).update({ collection: 'mailbox-configurations', id: mailbox.id, data: { inboundCursor: originalCursor, inboundCursorRevision: mailbox.credentialRevision }, overrideAccess: true, context: { mailboxInternal: true } })
  let messageFetches = 0
  await expect(syncMailboxInbound(payload, mailbox.id, async (url) => {
    if (url.includes('/token')) return Response.json({ access_token: 'gmail-access' })
    if (url.includes('/history?')) return Response.json({ historyId: '101', history: [{ messagesAdded: Array.from({ length: 501 }, (_, index) => ({ message: { id: `message-${index}` } })) }] })
    if (url.includes('/messages/')) { messageFetches += 1; return Response.json({}) }
    throw new Error(`unexpected ${url}`)
  })).rejects.toThrow('provider_page_too_large')
  const stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(stored.inboundCursor).toBe(originalCursor)
  expect(messageFetches).toBe(0)
})

test('credential refresh rotation retains the durable Gmail history cursor', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'gmail-rotation@example.test', name: 'Gmail rotation', roles: ['owner'] }, overrideAccess: true })
  const state = new URL(await startMailboxOAuth(payload, 'google', owner.id, 'gmail-rotation-session')).searchParams.get('state')!
  const mailbox = await completeMailboxOAuth(payload, 'google', state, 'code', owner.id, 'gmail-rotation-session', async (url) => url.includes('/token') ? Response.json({ access_token: 'setup-access', refresh_token: 'setup-refresh' }) : url.endsWith('/profile') ? Response.json({ emailAddress: 'gmail-rotation@example.test', historyId: '100' }) : Response.json({ sendAs: [{ sendAsEmail: 'gmail-rotation@example.test', verificationStatus: 'accepted' }] }))
  const originalCursor = JSON.stringify({ historyID: '100' })
  await (payload as any).update({ collection: 'mailbox-configurations', id: mailbox.id, data: { inboundCursor: originalCursor, inboundCursorRevision: mailbox.credentialRevision }, overrideAccess: true, context: { mailboxInternal: true } })
  let historyURL = ''
  await expect(syncMailboxInbound(payload, mailbox.id, async (url) => {
    if (url.includes('/token')) return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' })
    if (url.includes('/history?')) { historyURL = url; return Response.json({ historyId: '101', history: [] }) }
    throw new Error(`unexpected ${url}`)
  })).resolves.toMatchObject({ processed: 0 })
  expect(historyURL).toContain('startHistoryId=100')
  const stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(JSON.parse(stored.inboundCursor)).toEqual({ historyID: '101' })
  expect(stored.inboundCursorRevision).toBe(stored.credentialRevision)
  expect(stored.credentialRevision).not.toBe(mailbox.credentialRevision)
})

test('Gmail hydrates a durable intra-page batch without omitting IDs or advancing early', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'gmail-batch@example.test', name: 'Gmail batch', roles: ['owner'] }, overrideAccess: true })
  const state = new URL(await startMailboxOAuth(payload, 'google', owner.id, 'gmail-batch-session')).searchParams.get('state')!
  const mailbox = await completeMailboxOAuth(payload, 'google', state, 'code', owner.id, 'gmail-batch-session', async (url) => url.includes('/token') ? Response.json({ access_token: 'setup-access', refresh_token: 'refresh' }) : url.endsWith('/profile') ? Response.json({ emailAddress: 'gmail-batch@example.test', historyId: '100' }) : Response.json({ sendAs: [{ sendAsEmail: 'gmail-batch@example.test', verificationStatus: 'accepted' }] }))
  await (payload as any).update({ collection: 'mailbox-configurations', id: mailbox.id, data: { inboundCursor: JSON.stringify({ historyID: '100' }), inboundCursorRevision: mailbox.credentialRevision }, overrideAccess: true, context: { mailboxInternal: true } })
  let phase: 'normal' | 'crash' = 'normal'
  const ids = Array.from({ length: 12 }, (_, index) => `gmail-batch-${index + 1}`)
  const hydrated: string[] = []
  const fetcher = async (url: string) => {
    if (url.includes('/token')) return Response.json({ access_token: 'gmail-access' })
    if (url.includes('/history?')) return Response.json({ historyId: '200', history: [{ messagesAdded: ids.map((id) => ({ message: { id } })) }] })
    const id = ids.find((candidate) => url.includes(`/messages/${candidate}?`))
    if (id) {
      if (phase === 'crash' && id === 'gmail-batch-11') return Response.json({ id, threadId: '' })
      hydrated.push(id)
      return Response.json({ id, threadId: 'gmail-batch-thread', internalDate: '1791244800000', payload: { headers: [{ name: 'From', value: 'unmatched-batch@example.test' }, { name: 'To', value: 'gmail-batch@example.test' }, { name: 'Subject', value: id }], body: { data: Buffer.from(id).toString('base64url') } } })
    }
    throw new Error(`unexpected ${url}`)
  }
  await expect(syncMailboxInbound(payload, mailbox.id, fetcher)).resolves.toMatchObject({ processed: 10 })
  let stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(JSON.parse(stored.inboundCursor)).toEqual({ historyID: '100', offset: 10 })
  expect(stored.inboundCursor.length).toBeLessThanOrEqual(1000)
  phase = 'crash'
  await expect(syncMailboxInbound(payload, mailbox.id, fetcher)).rejects.toThrow('provider_malformed_response')
  stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(JSON.parse(stored.inboundCursor)).toEqual({ historyID: '100', offset: 10 })
  phase = 'normal'
  await expect(syncMailboxInbound(payload, mailbox.id, fetcher)).resolves.toMatchObject({ processed: 2 })
  stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(JSON.parse(stored.inboundCursor)).toEqual({ historyID: '200' })
  expect([...new Set(hydrated)].sort()).toEqual(ids.slice().sort())
  expect(hydrated.filter((id) => id === 'gmail-batch-1')).toHaveLength(1)
})

test('Gmail checkpoints each hydrated ID before an abort and resumes at the next ID', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'gmail-checkpoint@example.test', name: 'Gmail checkpoint', roles: ['owner'] }, overrideAccess: true })
  const state = new URL(await startMailboxOAuth(payload, 'google', owner.id, 'gmail-checkpoint-session')).searchParams.get('state')!
  const mailbox = await completeMailboxOAuth(payload, 'google', state, 'code', owner.id, 'gmail-checkpoint-session', async (url) => url.includes('/token') ? Response.json({ access_token: 'setup', refresh_token: 'refresh' }) : url.endsWith('/profile') ? Response.json({ emailAddress: 'gmail-checkpoint@example.test', historyId: '100' }) : Response.json({ sendAs: [{ sendAsEmail: 'gmail-checkpoint@example.test', verificationStatus: 'accepted' }] }))
  await (payload as any).update({ collection: 'mailbox-configurations', id: mailbox.id, data: { inboundCursor: JSON.stringify({ historyID: '100' }), inboundCursorRevision: mailbox.credentialRevision }, overrideAccess: true, context: { mailboxInternal: true } })
  const controller = new AbortController(); const fetched: string[] = []; let abortSecond = true
  const fetcher = async (url: string) => {
    if (url.includes('/token')) return Response.json({ access_token: 'access' })
    if (url.includes('/history?')) return Response.json({ historyId: '101', history: [{ messagesAdded: [{ message: { id: 'checkpoint-1' } }, { message: { id: 'checkpoint-2' } }] }] })
    const id = url.includes('checkpoint-1') ? 'checkpoint-1' : 'checkpoint-2'; fetched.push(id)
    if (id === 'checkpoint-2' && abortSecond) controller.abort()
    return Response.json({ id, threadId: 'unmatched-checkpoint', internalDate: '1791244800000', payload: { headers: [{ name: 'From', value: 'unmatched-checkpoint@example.test' }, { name: 'To', value: 'gmail-checkpoint@example.test' }, { name: 'Subject', value: id }], body: { data: Buffer.from(id).toString('base64url') } } })
  }
  await expect(syncMailboxInbound(payload, mailbox.id, fetcher, controller.signal)).rejects.toThrow('sync_aborted')
  let stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(JSON.parse(stored.inboundCursor)).toEqual({ historyID: '100', offset: 1 })
  abortSecond = false
  await expect(syncMailboxInbound(payload, mailbox.id, fetcher)).resolves.toMatchObject({ processed: 1 })
  stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(JSON.parse(stored.inboundCursor)).toEqual({ historyID: '101' })
  expect(fetched.filter((id) => id === 'checkpoint-1')).toHaveLength(1)
})

test('overlapping polls compare their original cursor before one can save over the other', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'sync-overlap@example.test', name: 'Sync overlap', roles: ['owner'] }, overrideAccess: true })
  const state = new URL(await startMailboxOAuth(payload, 'microsoft', owner.id, 'sync-overlap-session')).searchParams.get('state')!
  const mailbox = await completeMailboxOAuth(payload, 'microsoft', state, 'code', owner.id, 'sync-overlap-session', async (url) => url.includes('/token') ? Response.json({ access_token: 'setup-access', refresh_token: 'refresh' }) : Response.json({ mail: 'sync-overlap@example.test' }))
  const originalCursor = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=original'
  await (payload as any).update({ collection: 'mailbox-configurations', id: mailbox.id, data: { inboundCursor: originalCursor, inboundCursorRevision: mailbox.credentialRevision }, overrideAccess: true, context: { mailboxInternal: true } })
  let deltaCalls = 0
  const fetcher = async (url: string) => {
    if (url.includes('/token')) return Response.json({ access_token: 'sync-access' })
    if (url.includes('/delta')) {
      const call = ++deltaCalls
      return Response.json({ value: [], '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=overlap-${call}` })
    }
    throw new Error(`unexpected ${url}`)
  }
  const results = await Promise.allSettled([syncMailboxInbound(payload, mailbox.id, fetcher), syncMailboxInbound(payload, mailbox.id, fetcher)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(0)
  const stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true }) as any
  expect(stored.inboundCursor).toContain('overlap-2')
})
