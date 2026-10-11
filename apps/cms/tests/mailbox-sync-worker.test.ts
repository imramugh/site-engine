import { describe, expect, it } from 'vitest'
process.env.MAILBOX_WORKER_TOKEN = 't'.repeat(32)
const { createMailboxSyncWorkerRunHandler, mailboxSyncWorkerAuthorized, runMailboxSyncCycle } = await import('../src/mailbox-sync-worker.js')

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
    const payload = { find: async () => ({ docs: [] }) }
    await expect(runMailboxSyncCycle(payload, { sync: async () => ({ skipped: false as const, processed: 1 }) })).resolves.toEqual({ mailbox: null, processed: 0 })
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
      renew: async () => { renew++; throw new Error('renew failed') },
      fetcher: async () => new Response('{}'), budgetMS: 1000,
    }, Date.parse(due))
    expect(result).toEqual({ mailbox: 'mailbox-1', processed: 3 }); expect(access).toBe(1); expect(renew).toBe(1); expect(polled).toBe(1)
    expect(updates.at(-1).where.and).toEqual(expect.arrayContaining([{ credentialRevision: { equals: 'revision-1' } }, { inboundNextAttemptAt: { equals: due } }]))
  })
  it('does not acquire a token when Google notifications are disabled or active and unexpired', async () => {
    const original = process.env.MAILBOX_GOOGLE_PUBSUB_TOPIC; delete process.env.MAILBOX_GOOGLE_PUBSUB_TOPIC
    const google = { id: 'google-mailbox', provider: 'google', health: 'connected', credentialRevision: 'revision-1', inboundNextAttemptAt: due }
    let tokens = 0
    await runMailboxSyncCycle(payloadFixture(google, null), { sync: async () => ({ skipped: false as const, processed: 0 }), mailboxAccessToken: async () => { tokens++; return { accessToken: 'unused', credentialRevision: 'revision-1' } }, budgetMS: 1000 }, Date.parse(due))
    if (original) process.env.MAILBOX_GOOGLE_PUBSUB_TOPIC = original
    const microsoft = { id: 'microsoft-mailbox', provider: 'microsoft', health: 'connected', credentialRevision: 'revision-1', inboundNextAttemptAt: due }
    await runMailboxSyncCycle(payloadFixture(microsoft, { provider: 'microsoft', credentialRevision: 'revision-1', status: 'active', expiresAt: '2026-10-12T00:00:00.000Z' }), { sync: async () => ({ skipped: false as const, processed: 0 }), mailboxAccessToken: async () => { tokens++; return { accessToken: 'unused', credentialRevision: 'revision-1' } }, budgetMS: 1000 }, Date.parse(due))
    expect(tokens).toBe(0)
  })
  it('uses the due-time CAS so a notification received during polling is not deferred', async () => {
    const mailbox: any = { id: 'mailbox-race', provider: 'microsoft', health: 'connected', credentialRevision: 'revision-1', inboundNextAttemptAt: due }
    const updates: any[] = []
    await runMailboxSyncCycle(payloadFixture(mailbox, { provider: 'microsoft', credentialRevision: 'revision-1', status: 'active', expiresAt: '2026-10-12T00:00:00.000Z' }, input => updates.push(input)), { sync: async () => { mailbox.inboundNextAttemptAt = '2026-10-11T00:00:01.000Z'; return { skipped: false as const, processed: 1 } }, budgetMS: 1000 }, Date.parse(due))
    expect(updates.at(-1).where.and).toEqual(expect.arrayContaining([{ inboundNextAttemptAt: { equals: due } }]))
    expect(updates.at(-1).data.inboundNextAttemptAt).toBe('2026-10-11T00:03:00.000Z')
  })
})
