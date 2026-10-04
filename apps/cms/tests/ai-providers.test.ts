import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-ai-providers-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'synthetic-ai-provider-payload-secret-that-is-long-enough'
process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64url')
const { default: config } = await import('../payload.config.js')
const { executeConfiguredAIJob, invokeProvider } = await import('../src/ai-providers.js')
const { encryptCredential, publicIntegration } = await import('../src/integrations.js')
let payload: Awaited<ReturnType<typeof getPayload>>
const now = new Date('2026-10-04T12:00:00.000Z')
const pricing = { inputMicroUsdPerMillionTokens: 1_000_000, outputMicroUsdPerMillionTokens: 2_000_000, pricingSource: 'https://prices.example.test/review-2026-10-04', pricingAsOf: '2026-10-04T00:00:00.000Z' }
beforeAll(async () => { payload = await getPayload({ config }) })
beforeEach(async () => { await (payload.db as unknown as { client: { execute: (query: string) => Promise<unknown> } }).client.execute('DELETE FROM integration_configurations') })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })
async function configured(provider: 'openai' | 'anthropic' | 'google-gemini' | 'openrouter', model: string, credential: string, extra: Record<string, unknown> = {}) { return payload.create({ collection: 'integration-configurations', data: { provider, model, encryptedCredential: encryptCredential(credential, provider), credentialFingerprint: 'masked', health: 'unknown', ...pricing, ...extra } as never, overrideAccess: true }) }
const job = (provider: 'openai' | 'anthropic' | 'google-gemini' | 'openrouter', input = 'hello') => ({ provider, input, maxOutputTokens: 10 })

describe('ENG-023 provider monetary accounting', () => {
  it('bounds output for every provider and settles normalized token usage in micro-USD', async () => {
    const records = [await configured('openai', 'gpt-test', 'openai-secret'), await configured('anthropic', 'claude-test', 'anthropic-secret'), await configured('google-gemini', 'gemini test/model', 'gemini-secret'), await configured('openrouter', 'provider/model', 'router-secret')]
    const observed: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const transport = async (request: Request) => { const body = await request.json() as Record<string, unknown>; observed.push({ url: request.url, headers: request.headers, body }); if (request.url.includes('openai.com')) return Response.json({ output: [{ content: [{ type: 'output_text', text: 'openai answer' }] }], usage: { input_tokens: 2, output_tokens: 3 } }); if (request.url.includes('anthropic.com')) return Response.json({ content: [{ type: 'text', text: 'anthropic answer' }], usage: { input_tokens: 2, output_tokens: 3 } }); if (request.url.includes('googleapis.com')) return Response.json({ candidates: [{ content: { parts: [{ text: 'gemini answer' }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } }); return Response.json({ choices: [{ message: { content: 'router answer' } }], usage: { prompt_tokens: 2, completion_tokens: 3, cost: 0.000001 } }) }
    for (const provider of ['openai', 'anthropic', 'google-gemini', 'openrouter'] as const) await expect(executeConfiguredAIJob(payload, job(provider), { transport, now })).resolves.toMatchObject({ provider, usageCostMicroUsd: 8 })
    expect(observed[0]).toMatchObject({ url: 'https://api.openai.com/v1/responses', body: { max_output_tokens: 10 } }); expect(observed[1]).toMatchObject({ url: 'https://api.anthropic.com/v1/messages', body: { max_tokens: 10 } }); expect(observed[2]).toMatchObject({ url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini%20test%2Fmodel:generateContent', body: { generationConfig: { maxOutputTokens: 10 } } }); expect(observed[3]).toMatchObject({ url: 'https://openrouter.ai/api/v1/chat/completions', body: { max_tokens: 10 } })
    for (const record of records) { const saved = await payload.findByID({ collection: 'integration-configurations', id: record.id, overrideAccess: true }); expect(saved).toMatchObject({ monthlyUsageMicroUsd: 8 }); expect(publicIntegration(saved as unknown as Record<string, unknown>)).not.toHaveProperty('encryptedCredential') }
  })

  it('fails closed for an unknown model price before transport', async () => {
    await configured('openai', 'unreviewed-model', 'secret', { inputMicroUsdPerMillionTokens: null, outputMicroUsdPerMillionTokens: null, pricingSource: null, pricingAsOf: null })
    let contacted = false
    await expect(executeConfiguredAIJob(payload, job('openai'), { now, transport: async () => { contacted = true; return Response.json({}) } })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    expect(contacted).toBe(false)
  })

  it('reserves request framing and serializes real SQLite cap decisions', async () => {
    const record = await configured('openai', 'concurrent', 'secret', { monthlyCapMicroUsd: 200, monthlyUsageMicroUsd: 0, usageMonth: '2026-10' })
    let contacted = 0
    const transport = async () => { contacted += 1; return Response.json({ output: [{ content: [{ type: 'output_text', text: 'reserved' }] }], usage: { input_tokens: 5, output_tokens: 10 } }) }
    const jobs = await Promise.allSettled([executeConfiguredAIJob(payload, job('openai'), { now, transport }), executeConfiguredAIJob(payload, job('openai'), { now, transport })])
    expect(jobs.filter((result) => result.status === 'fulfilled')).toHaveLength(1); expect(contacted).toBe(1)
    expect(await payload.findByID({ collection: 'integration-configurations', id: record.id, overrideAccess: true })).toMatchObject({ monthlyUsageMicroUsd: 25, monthlyCapMicroUsd: 200 })
  })

  it('keeps reservations for unknown usage and timeouts so a retry cannot reuse the cap', async () => {
    const record = await configured('openai', 'bounded', 'secret', { monthlyCapMicroUsd: 500, monthlyUsageMicroUsd: 0, usageMonth: '2026-10' })
    await expect(executeConfiguredAIJob(payload, job('openai'), { now, transport: async () => Response.json({ output: [{ content: [{ type: 'output_text', text: 'unmetered' }] }], usage: { total_tokens: 1 } }) })).resolves.toMatchObject({ usageCostMicroUsd: expect.any(Number) })
    const afterUnknown = await payload.findByID({ collection: 'integration-configurations', id: record.id, overrideAccess: true })
    expect(afterUnknown.monthlyUsageMicroUsd).toBeGreaterThan(25)
    let aborted = false
    await expect(executeConfiguredAIJob(payload, job('openai'), { now, timeoutMs: 5, transport: async request => new Promise((_, reject) => request.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })) })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    const afterTimeout = await payload.findByID({ collection: 'integration-configurations', id: record.id, overrideAccess: true })
    expect(aborted).toBe(true); expect(afterTimeout).toMatchObject({ health: 'unavailable' }); expect(afterTimeout.monthlyUsageMicroUsd).toBeGreaterThan(afterUnknown.monthlyUsageMicroUsd!)
  })

  it('bounds a response body that never finishes decoding', async () => {
    const started = Date.now()
    await expect(invokeProvider('openai', 'secret', 'model', 'prompt', 10, async () => new Response(new ReadableStream({ start() {} })), 5)).resolves.toEqual({ outcome: 'unavailable' })
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('returns only final text parts and rejects reasoning-only provider responses', async () => {
    await expect(invokeProvider('openai', 'secret', 'model', 'prompt', 10, async () => Response.json({ output: [{ content: [{ type: 'reasoning', text: 'private' }, { type: 'output_text', text: 'final ' }, { type: 'output_text', text: 'answer' }] }], usage: { input_tokens: 1, output_tokens: 2 } }))).resolves.toMatchObject({ outcome: 'success', output: 'final answer' })
    await expect(invokeProvider('anthropic', 'secret', 'model', 'prompt', 10, async () => Response.json({ content: [{ type: 'thinking', text: 'private' }, { type: 'text', text: 'final ' }, { type: 'text', text: 'answer' }], usage: { input_tokens: 1, output_tokens: 2 } }))).resolves.toMatchObject({ outcome: 'success', output: 'final answer' })
    await expect(invokeProvider('google-gemini', 'secret', 'model', 'prompt', 10, async () => Response.json({ candidates: [{ content: { parts: [{ thought: true, text: 'private' }, { text: 'final ' }, { text: 'answer' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: 3 } }))).resolves.toMatchObject({ outcome: 'success', output: 'final answer' })
    await expect(invokeProvider('google-gemini', 'secret', 'model', 'prompt', 10, async () => Response.json({ candidates: [{ content: { parts: [{ thought: true, text: 'private' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0, thoughtsTokenCount: 3 } }))).resolves.toEqual({ outcome: 'unavailable' })
  })

  it('records actual usage above its reservation and closes the cap to later work', async () => {
    const record = await configured('openai', 'overrun', 'secret', { monthlyCapMicroUsd: 250, monthlyUsageMicroUsd: 0, usageMonth: '2026-10' })
    let contacted = 0
    const transport = async () => { contacted += 1; return Response.json({ output: [{ content: [{ type: 'output_text', text: 'expensive' }] }], usage: { input_tokens: 100, output_tokens: 100 } }) }
    await expect(executeConfiguredAIJob(payload, job('openai'), { now, transport })).resolves.toMatchObject({ usageCostMicroUsd: 300 })
    await expect(executeConfiguredAIJob(payload, job('openai'), { now, transport })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    expect(contacted).toBe(1)
    expect(await payload.findByID({ collection: 'integration-configurations', id: record.id, overrideAccess: true })).toMatchObject({ monthlyUsageMicroUsd: 300 })
  })

  it('charges Gemini thought tokens with candidate output and retains malformed thinking usage', async () => {
    const record = await configured('google-gemini', 'thinking', 'secret', { monthlyCapMicroUsd: 500, monthlyUsageMicroUsd: 0, usageMonth: '2026-10' })
    await expect(executeConfiguredAIJob(payload, job('google-gemini'), { now, transport: async () => Response.json({ candidates: [{ content: { parts: [{ text: 'answer' }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 4 } }) })).resolves.toMatchObject({ usageCostMicroUsd: 16 })
    expect(await payload.findByID({ collection: 'integration-configurations', id: record.id, overrideAccess: true })).toMatchObject({ monthlyUsageMicroUsd: 16 })
    await payload.update({ collection: 'integration-configurations', id: record.id, data: { model: 'thinking-malformed', monthlyCapMicroUsd: 200, monthlyUsageMicroUsd: 0, usageMonth: '2026-10' } as never, overrideAccess: true })
    await expect(executeConfiguredAIJob(payload, job('google-gemini'), { now, transport: async () => Response.json({ candidates: [{ content: { parts: [{ text: 'answer' }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 'unknown' } }) })).resolves.toMatchObject({ output: 'answer' })
    expect((await payload.findByID({ collection: 'integration-configurations', id: record.id, overrideAccess: true })).monthlyUsageMicroUsd).toBeGreaterThan(16)
  })

  it('retains malformed and 5xx reservations and never contacts providers for image jobs', async () => {
    const malformed = await configured('openai', 'malformed', 'secret', { monthlyCapMicroUsd: 200, monthlyUsageMicroUsd: 0, usageMonth: '2026-10' })
    let malformedCalls = 0
    await expect(executeConfiguredAIJob(payload, job('openai'), { now, transport: async () => { malformedCalls += 1; return Response.json({ output: [] }) } })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    await expect(executeConfiguredAIJob(payload, job('openai'), { now, transport: async () => { malformedCalls += 1; return Response.json({}) } })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    expect(malformedCalls).toBe(1)
    expect((await payload.findByID({ collection: 'integration-configurations', id: malformed.id, overrideAccess: true })).monthlyUsageMicroUsd).toBeGreaterThan(0)
    await configured('anthropic', 'server-error', 'secret', { monthlyCapMicroUsd: 200, monthlyUsageMicroUsd: 0, usageMonth: '2026-10' })
    let serverErrorCalls = 0
    await expect(executeConfiguredAIJob(payload, job('anthropic'), { now, transport: async () => { serverErrorCalls += 1; return new Response('{}', { status: 503 }) } })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    await expect(executeConfiguredAIJob(payload, job('anthropic'), { now, transport: async () => { serverErrorCalls += 1; return Response.json({}) } })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    expect(serverErrorCalls).toBe(1)
    let imageCalls = 0
    await expect(executeConfiguredAIJob(payload, { ...job('openai'), requiresImage: true }, { now, transport: async () => { imageCalls += 1; return Response.json({}) } })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    expect(imageCalls).toBe(0)
  })

  it('does not settle a rotated configuration with an old credential snapshot', async () => {
    const record = await configured('openai', 'old-model', 'old-secret', { monthlyCapMicroUsd: 500, monthlyUsageMicroUsd: 0, usageMonth: '2026-10' })
    await expect(executeConfiguredAIJob(payload, job('openai'), { now, transport: async () => {
      await payload.update({ collection: 'integration-configurations', id: record.id, data: { model: 'new-model', encryptedCredential: encryptCredential('new-secret', 'openai'), credentialFingerprint: 'new-fingerprint' } as never, overrideAccess: true })
      return Response.json({ output: [{ content: [{ type: 'output_text', text: 'old response' }] }], usage: { input_tokens: 2, output_tokens: 3 } })
    } })).resolves.toMatchObject({ output: 'old response' })
    const saved = await payload.findByID({ collection: 'integration-configurations', id: record.id, overrideAccess: true })
    expect(saved).toMatchObject({ model: 'new-model', credentialFingerprint: 'new-fingerprint' })
    expect(saved.monthlyUsageMicroUsd).toBeGreaterThan(25)
  })

  it('does not retry rejected credentials or disclose them from direct invocation', async () => {
    await configured('google-gemini', 'gemini-test', 'do-not-leak'); await configured('openrouter', 'fallback', 'also-not-leaked'); const requests: Request[] = []
    await expect(executeConfiguredAIJob(payload, { ...job('google-gemini'), fallbackProvider: 'openrouter' }, { now, transport: async request => { requests.push(request); return new Response('{}', { status: 401 }) } })).rejects.toThrow('AI_JOB_UNAVAILABLE'); expect(requests).toHaveLength(1)
    const direct = await invokeProvider('openai', 'do-not-leak', 'model', 'prompt', 10, async () => new Response('{"error":"bad key"}', { status: 401 })); expect(direct).toEqual({ outcome: 'rejected' }); expect(JSON.stringify(direct)).not.toContain('do-not-leak')
  })
})
