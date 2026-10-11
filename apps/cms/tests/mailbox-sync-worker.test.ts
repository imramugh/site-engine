import { describe, expect, it } from 'vitest'
process.env.MAILBOX_WORKER_TOKEN = 't'.repeat(32)
const { createMailboxSyncWorkerRunHandler, mailboxSyncWorkerAuthorized, runMailboxSyncCycle } = await import('../src/mailbox-sync-worker.js')
const { notificationCredentialRevision } = await import('../src/mailbox-notifications.js')

const due = '2026-10-11T00:00:00.000Z'
function payloadFixture(mailbox: any, notification: any, onUpdate?: (input: any) => void) {
  return {
    find: async (input: any) => input.collection === 'mailbox-configurations' ? { docs: [mailbox] } : { docs: notification ? [notification] : [] },
    findByID: async () => mailbox,
    update: async (input: any) => { onUpdate?.(input); return { docs: [mailbox] } },
  }
}

describe('mailbox sync worker', () => {
  it('fails closed and does not run without a configured mailbox', async () => {
    expect(mailboxSyncWorkerAuthorized(new Request('http://cms.test'))).toBe(false)
    await expect(runMailboxSyncCycle({ find: async () => ({ docs: [] }) }, { sync: async () => ({ skipped: false as const, processed: 1 }) })).resolves.toEqual({ mailbox: null, processed: 0 })
  })
  it('uses its own private constant-time route boundary', async () => {
    const handler = createMailboxSyncWorkerRunHandler({ payload: async () => ({}), run: async () => ({ mailbox: 'mailbox-1', processed: 2 }) })
    expect((await handler(new Request('http://cms.test', { method: 'POST' }))).status).toBe(401)
    await expect((await handler(new Request('http://cms.test', { method: 'POST', headers: { authorization: `Bearer ${'t'.repeat(32)}` } }))).json()).resolves.toEqual({ mailbox: 'mailbox-1', processed: 2 })
  })
  it('continues polling when subscription renewal fails and shares its deadline fetch wrapper', async () => {
    const mailbox = { id: 'mailbox-1', provider: 'microsoft', health: 'connected', credentialRevision: 'revision-1', inboundNextAttemptAt: due }
    let access = 0; let renew = 0; let polled = 0; const updates: any[] = []
    const result = await runMailboxSyncCycle(payloadFixture(mailbox, null, input => updates.push(input)), {
      sync: async (_payload, _id, fetcher, signal) => { polled++; expect(signal?.aborted).toBe(false); await fetcher!('https://provider.test/poll', { headers: {} }); return { skipped: false as const, processed: 3 } },
      mailboxAccessToken: async (_payload: any, _mailbox: any, fetcher: any) => { access++; await fetcher('https://provider.test/token', { headers: {} }); return { accessToken: 'token', credentialRevision: 'revision-1' } },
      renew: async () => { renew++; throw new Error('renew failed') }, fetcher: async () => new Response('{}'), budgetMS: 1000,
    }, Date.parse(due))
    expect(result).toEqual({ mailbox: 'mailbox-1', processed: 3 }); expect(access).toBe(1); expect(renew).toBe(1); expect(polled).toBe(1)
    expect(updates.at(-1).where.and).toEqual(expect.arrayContaining([{ credentialRevision: { equals: 'revision-1' } }, { inboundNextAttemptAt: { equals: due } }]))
  })
  it('does not acquire a token when Google notifications are disabled, or a binding is active beyond five minutes', async () => {
    const original = process.env.MAILBOX_GOOGLE_PUBSUB_TOPIC; delete process.env.MAILBOX_GOOGLE_PUBSUB_TOPIC
    const google = { id: 'google-mailbox', provider: 'google', health: 'connected', credentialRevision: 'revision-1', inboundNextAttemptAt: due }
    let tokens = 0
    await runMailboxSyncCycle(payloadFixture(google, null), { sync: async () => ({ skipped: false as const, processed: 0 }), mailboxAccessToken: async () => { tokens++; return { accessToken: 'unused', credentialRevision: 'revision-1' } }, budgetMS: 1000 }, Date.parse(due))
    if (original) process.env.MAILBOX_GOOGLE_PUBSUB_TOPIC = original
    const microsoft = { id: 'microsoft-mailbox', provider: 'microsoft', health: 'connected', credentialRevision: 'revision-1', inboundNextAttemptAt: due }
    await runMailboxSyncCycle(payloadFixture(microsoft, { provider: 'microsoft', credentialRevision: notificationCredentialRevision(microsoft), status: 'active', expiresAt: '2026-10-11T00:06:00.000Z' }), { sync: async () => ({ skipped: false as const, processed: 0 }), mailboxAccessToken: async () => { tokens++; return { accessToken: 'unused', credentialRevision: 'revision-1' } }, budgetMS: 1000 }, Date.parse(due))
    expect(tokens).toBe(0)
  })
  it('honors renewal backoff only while the notification credential binding matches', async () => {
    const mailbox = { id: 'mailbox-backoff', provider: 'microsoft', health: 'connected', credentialRevision: 'revision-1', inboundNextAttemptAt: due }; let tokens = 0
    await runMailboxSyncCycle(payloadFixture(mailbox, { provider: 'microsoft', credentialRevision: notificationCredentialRevision(mailbox), status: 'failed', nextRenewAttemptAt: '2026-10-11T00:10:00.000Z' }), { sync: async () => ({ skipped: false as const, processed: 0 }), mailboxAccessToken: async () => { tokens++; return { accessToken: 'unused', credentialRevision: 'revision-1' } }, budgetMS: 1000 }, Date.parse(due))
    await runMailboxSyncCycle(payloadFixture(mailbox, { provider: 'microsoft', credentialRevision: 'stale', status: 'failed', nextRenewAttemptAt: '2026-10-11T00:10:00.000Z' }), { sync: async () => ({ skipped: false as const, processed: 0 }), mailboxAccessToken: async () => { tokens++; return { accessToken: 'used', credentialRevision: 'revision-1' } }, renew: (async () => undefined) as never, budgetMS: 1000 }, Date.parse(due))
    expect(tokens).toBe(1)
  })
  it('uses the original due-time and credential CAS, so notification or config changes are not overwritten', async () => {
    const mailbox: any = { id: 'mailbox-race', provider: 'microsoft', health: 'connected', credentialRevision: 'before', inboundNextAttemptAt: due }; const updates: any[] = []
    await runMailboxSyncCycle(payloadFixture(mailbox, { provider: 'microsoft', credentialRevision: notificationCredentialRevision(mailbox), status: 'active', expiresAt: '2026-10-11T00:06:00.000Z' }, input => updates.push(input)), { sync: async () => { mailbox.inboundNextAttemptAt = '2026-10-11T00:00:01.000Z'; mailbox.credentialRevision = 'after'; return { skipped: false as const, processed: 1 } }, budgetMS: 1000 }, Date.parse(due))
    expect(updates.at(-1).where.and).toEqual(expect.arrayContaining([{ credentialRevision: { equals: 'before' } }, { inboundNextAttemptAt: { equals: due } }]))
  })
  it('aborts an in-flight network poll at its cycle deadline', async () => {
    const mailbox = { id: 'mailbox-deadline', provider: 'microsoft', health: 'connected', credentialRevision: 'revision-1', inboundNextAttemptAt: due }; let aborted = false
    const result = await runMailboxSyncCycle(payloadFixture(mailbox, { provider: 'microsoft', credentialRevision: notificationCredentialRevision(mailbox), status: 'active', expiresAt: '2026-10-11T00:06:00.000Z' }), {
      sync: async (_payload, _id, fetcher) => { await fetcher!('https://provider.test/hang', { headers: {} }); return { skipped: false as const, processed: 1 } },
      fetcher: async (_url, init) => await new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })), budgetMS: 10,
    }, Date.parse(due))
    expect(aborted).toBe(true); expect(result).toEqual({ mailbox: 'mailbox-deadline', processed: 0 })
  })
})
