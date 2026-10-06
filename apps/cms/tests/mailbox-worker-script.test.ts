import { describe, expect, it, vi } from 'vitest'
const { createMailboxWorkerAPI, runMailboxWorker } = await import('../scripts/run-mailbox-worker.mjs')
const token = 't'.repeat(32)
describe('mailbox polling HTTP contract', () => {
  it('accepts both active and idle cycle responses from the real route contract', async () => {
    for (const body of [{ mailbox: 'mailbox-1', processed: 2 }, { mailbox: null, processed: 0 }]) {
      const api = createMailboxWorkerAPI({ cmsOrigin: 'http://cms:3001', token, fetchImpl: async (url, init) => {
        expect(String(url)).toBe('http://cms:3001/api/internal/mailbox-worker/run')
        expect(init?.method).toBe('POST'); expect(init?.body).toBeUndefined()
        expect(init?.headers).toEqual({ authorization: `Bearer ${token}` })
        return Response.json(body)
      } })
      await expect(api()).resolves.toEqual(body)
    }
  })
  it('rejects leaked metadata, invalid counts and old notification-shaped responses', async () => {
    for (const body of [{ mailbox: { id: 'one', state: 'sent' } }, { mailbox: 'one', processed: -1 }, { mailbox: null, processed: 0, token }, { mailbox: null, processed: 1 }]) {
      const api = createMailboxWorkerAPI({ cmsOrigin: 'http://cms:3001', token, fetchImpl: async () => Response.json(body) })
      await expect(api()).rejects.toThrow('INVALID_CMS_RESPONSE')
    }
  })
  it('remains sequential and writes a heartbeat only after a valid poll', async () => {
    const controller = new AbortController(); let calls = 0; let running = 0; let peak = 0
    const heartbeat = vi.fn(async () => { if (calls === 2) controller.abort() })
    await runMailboxWorker({ api: async () => { calls++; running++; peak = Math.max(peak, running); await Promise.resolve(); running--; return { mailbox: null, processed: 0 } }, heartbeat, signal: controller.signal, idleMs: 100 })
    expect(peak).toBe(1); expect(heartbeat).toHaveBeenCalledTimes(2)
  })
})
