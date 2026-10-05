import { describe, expect, it, vi } from 'vitest'
const { NotificationWorkerError, createNotificationWorkerAPI, normalizeCMSOrigin, runNotificationWorker } = await import('../scripts/run-notification-worker.mjs')

describe('notification worker HTTP poller', () => {
  it('accepts only a root internal origin and redacted delivery result', async () => {
    for (const origin of [undefined, 'ftp://cms.test', 'https://cms.test/path', 'https://user:pass@cms.test']) expect(() => normalizeCMSOrigin(origin)).toThrow('INVALID_WORKER_CONFIGURATION')
    const api = createNotificationWorkerAPI({ cmsOrigin: 'https://cms.test/', token: 't'.repeat(32), fetchImpl: async (url, init) => { expect(String(url)).toBe('https://cms.test/api/internal/notification-worker/run'); expect(init?.method).toBe('POST'); expect(init?.body).toBeUndefined(); return Response.json({ delivery: { id: 'receipt-1', state: 'delivered' } }) } })
    await expect(api()).resolves.toEqual({ id: 'receipt-1', state: 'delivered' })
    expect(() => createNotificationWorkerAPI({ cmsOrigin: 'https://cms.test', token: 'short' })).toThrow('INVALID_WORKER_CONFIGURATION')
  })

  it('rejects private response fields and never overlaps polls', async () => {
    const invalid = createNotificationWorkerAPI({ cmsOrigin: 'http://localhost:3000', token: 't'.repeat(32), fetchImpl: async () => Response.json({ delivery: { id: 'receipt', state: 'delivered', recipient: 'private@example.test' } }) })
    await expect(invalid()).rejects.toBeInstanceOf(NotificationWorkerError)
    const controller = new AbortController(); let calls = 0; let running = 0; let maximum = 0
    await runNotificationWorker({ api: async () => { calls += 1; running += 1; maximum = Math.max(maximum, running); await Promise.resolve(); running -= 1; if (calls === 3) controller.abort(); return null }, signal: controller.signal, idleMs: 100, errorMs: 100, log: vi.fn() })
    expect(calls).toBe(3); expect(maximum).toBe(1)
  })
})
