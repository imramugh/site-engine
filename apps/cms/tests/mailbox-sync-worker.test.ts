import { describe, expect, it } from 'vitest'
process.env.MAILBOX_WORKER_TOKEN = 't'.repeat(32)
const { createMailboxSyncWorkerRunHandler, mailboxSyncWorkerAuthorized, runMailboxSyncCycle } = await import('../src/mailbox-sync-worker.js')

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
})
