import { describe, expect, it, vi } from 'vitest'
const { AIWorkerError, createAIWorkerAPI, normalizeCMSOrigin, runAIWorker } = await import('../scripts/run-ai-worker.mjs')

describe('AI worker HTTP poller', () => {
  it('validates an HTTP(S) root CMS origin and returns only redacted job metadata', async () => {
    for (const origin of [undefined, 'ftp://cms.test', 'https://cms.test/path', 'https://user:pass@cms.test']) expect(() => normalizeCMSOrigin(origin)).toThrow('INVALID_WORKER_CONFIGURATION')
    const api = createAIWorkerAPI({ cmsOrigin: 'https://cms.internal/', token: 't'.repeat(32), fetchImpl: async (url: URL | RequestInfo, init?: RequestInit) => { expect(String(url)).toBe('https://cms.internal/api/internal/ai-worker/run'); expect(init?.method).toBe('POST'); expect(init?.body).toBeUndefined(); return Response.json({ job: { id: 'job-1', state: 'completed' } }) } })
    await expect(api()).resolves.toEqual({ id: 'job-1', state: 'completed' })
  })

  it('rejects non-redacted CMS responses and retries sequentially without overlap', async () => {
    const invalid = createAIWorkerAPI({ cmsOrigin: 'http://localhost:3000', token: 't'.repeat(32), fetchImpl: async () => Response.json({ job: { id: 'job', state: 'completed', input: 'private' } }) })
    await expect(invalid()).rejects.toBeInstanceOf(AIWorkerError)
    const controller = new AbortController(); let running = 0; let maximum = 0; let calls = 0
    const api = async () => { calls += 1; running += 1; maximum = Math.max(maximum, running); await Promise.resolve(); running -= 1; if (calls === 3) controller.abort(); return null }
    await runAIWorker({ api, signal: controller.signal, idleMs: 0, errorMs: 0, log: vi.fn() })
    expect(calls).toBe(3); expect(maximum).toBe(1)
  })

  it('backs off after a failed HTTP poll without overlapping the retry', async () => {
    const controller = new AbortController(); let calls = 0; let running = 0; let maximum = 0
    const api = createAIWorkerAPI({ cmsOrigin: 'http://localhost:3000', token: 't'.repeat(32), fetchImpl: async () => { calls += 1; running += 1; maximum = Math.max(maximum, running); await Promise.resolve(); running -= 1; if (calls === 1) throw new Error('synthetic network failure'); controller.abort(); return Response.json({ job: null }) } })
    await runAIWorker({ api, signal: controller.signal, idleMs: 0, errorMs: 0, log: vi.fn() })
    expect(calls).toBe(2); expect(maximum).toBe(1)
  })
})
