import { afterEach, describe, expect, it, vi } from 'vitest'

process.env.AI_WORKER_TOKEN = 'synthetic-ai-worker-token-long-enough-for-tests'
const { aiWorkerAuthorized, createAIWorkerRunHandler } = await import('../src/ai-worker.js')

describe('configured AI worker route', () => {
  afterEach(() => { process.env.AI_WORKER_TOKEN = 'synthetic-ai-worker-token-long-enough-for-tests' })
  const request = (token?: string, body?: unknown) => new Request('http://cms.test/api/internal/ai-worker/run', { method: 'POST', headers: token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) })

  it('fails closed for absent, short, and wrong worker tokens', async () => {
    const handler = createAIWorkerRunHandler({ payload: vi.fn(), run: vi.fn() })
    process.env.AI_WORKER_TOKEN = ''
    expect(aiWorkerAuthorized(request('x'.repeat(40)))).toBe(false)
    expect((await handler(request())).status).toBe(401)
    process.env.AI_WORKER_TOKEN = 'synthetic-ai-worker-token-long-enough-for-tests'
    expect((await handler(request('short'))).status).toBe(401)
    expect((await handler(request('x'.repeat(48)))).status).toBe(401)
  })

  it('runs one CMS-owned job and returns only its identifier and state', async () => {
    const payload = vi.fn(async () => ({ cms: true })); const run = vi.fn(async () => ({ id: 'job-123', state: 'completed', input: 'never disclose', result: 'never disclose', encryptedCredential: 'never disclose' }))
    const response = await createAIWorkerRunHandler({ payload, run })(request(process.env.AI_WORKER_TOKEN, { provider: 'openai', input: 'attacker data' }))
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ job: { id: 'job-123', state: 'completed' } })
    expect(payload).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledWith({ cms: true })
  })

  it('does not disclose execution errors or invoke the runner on unauthorized input', async () => {
    const run = vi.fn(async () => { throw new Error('credential=secret prompt=private') }); const handler = createAIWorkerRunHandler({ payload: async () => ({}), run })
    const failed = await handler(request(process.env.AI_WORKER_TOKEN)); expect(failed.status).toBe(503); expect(await failed.json()).toEqual({ error: 'unavailable' })
    await handler(request('wrong-token-that-is-deliberately-long-enough'))
    expect(run).toHaveBeenCalledOnce()
  })
})
