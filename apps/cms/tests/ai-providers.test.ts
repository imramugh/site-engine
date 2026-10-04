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
const now = new Date('2026-10-03T12:00:00.000Z')
beforeAll(async () => { payload = await getPayload({ config }) })
beforeEach(async () => { await (payload.db as unknown as { client: { execute: (query: string) => Promise<unknown> } }).client.execute('DELETE FROM integration_configurations') })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })
async function configured(provider: 'openai' | 'anthropic' | 'google-gemini' | 'openrouter', model: string, credential: string, extra: Record<string, unknown> = {}) { return payload.create({ collection: 'integration-configurations', data: { provider, model, encryptedCredential: encryptCredential(credential, provider), credentialFingerprint: 'masked', health: 'unknown', ...extra } as never, overrideAccess: true }) }

describe('ENG-023 provider protocol execution', () => {
  it('sends and parses each provider protocol through an injected HTTP transport', async () => {
    const records = [await configured('openai', 'gpt-test', 'openai-secret'), await configured('anthropic', 'claude-test', 'anthropic-secret'), await configured('google-gemini', 'gemini test/model', 'gemini-secret'), await configured('openrouter', 'provider/model', 'router-secret')]
    const observed: Array<{ url: string; headers: Headers; body: unknown }> = []
    const transport = async (request: Request) => { observed.push({ url: request.url, headers: request.headers, body: await request.json() }); if (request.url.includes('openai.com')) return Response.json({ output: [{ content: [{ type: 'output_text', text: 'openai answer' }] }], usage: { total_tokens: 12 } }); if (request.url.includes('anthropic.com')) return Response.json({ content: [{ type: 'text', text: 'anthropic answer' }], usage: { input_tokens: 4, output_tokens: 8 } }); if (request.url.includes('googleapis.com')) return Response.json({ candidates: [{ content: { parts: [{ text: 'gemini answer' }] } }], usageMetadata: { totalTokenCount: 12 } }); return Response.json({ choices: [{ message: { content: 'router answer' } }], usage: { cost: 0.25 } }) }
    await expect(executeConfiguredAIJob(payload, { provider: 'openai', input: 'hello', estimatedCost: 20 }, { transport, now })).resolves.toMatchObject({ output: 'openai answer', usageCost: 12 })
    await expect(executeConfiguredAIJob(payload, { provider: 'anthropic', input: 'hello', estimatedCost: 20 }, { transport, now })).resolves.toMatchObject({ output: 'anthropic answer', usageCost: 12 })
    await expect(executeConfiguredAIJob(payload, { provider: 'google-gemini', input: 'hello', estimatedCost: 20 }, { transport, now })).resolves.toMatchObject({ output: 'gemini answer', usageCost: 12 })
    await expect(executeConfiguredAIJob(payload, { provider: 'openrouter', input: 'hello', estimatedCost: 20 }, { transport, now })).resolves.toMatchObject({ output: 'router answer', usageCost: 0.25 })
    expect(observed[0]).toMatchObject({ url: 'https://api.openai.com/v1/responses', body: { model: 'gpt-test', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] } }); expect(observed[0]!.headers.get('authorization')).toBe('Bearer openai-secret')
    expect(observed[1]).toMatchObject({ url: 'https://api.anthropic.com/v1/messages', body: { model: 'claude-test', max_tokens: 1024, messages: [{ role: 'user', content: 'hello' }] } }); expect(observed[1]!.headers.get('x-api-key')).toBe('anthropic-secret'); expect(observed[1]!.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(observed[2]).toMatchObject({ url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini%20test%2Fmodel:generateContent', body: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] } }); expect(observed[2]!.headers.get('x-goog-api-key')).toBe('gemini-secret')
    expect(observed[3]).toMatchObject({ url: 'https://openrouter.ai/api/v1/chat/completions', body: { model: 'provider/model', messages: [{ role: 'user', content: 'hello' }] } }); expect(observed[3]!.headers.get('authorization')).toBe('Bearer router-secret')
    for (const record of records) expect(publicIntegration(record as unknown as Record<string, unknown>)).not.toHaveProperty('encryptedCredential')
  })

  it('uses fallback only for availability failures, accounts usage, and enforces the cap before HTTP', async () => {
    const primary = await configured('openai', 'primary', 'primary-secret', { fallbackProvider: 'anthropic', monthlyCap: 10, monthlyUsage: 2, usageMonth: '2026-10' }); const fallback = await configured('anthropic', 'fallback', 'fallback-secret', { monthlyCap: 10, monthlyUsage: 0, usageMonth: '2026-10' }); const calls: string[] = []
    const result = await executeConfiguredAIJob(payload, { provider: 'openai', fallbackProvider: 'anthropic', input: 'fallback please', estimatedCost: 3 }, { now, transport: async request => { calls.push(request.url); return request.url.includes('openai.com') ? new Response('{}', { status: 503 }) : Response.json({ content: [{ type: 'text', text: 'fallback answer' }], usage: { input_tokens: 1, output_tokens: 2 } }) } })
    expect(result).toMatchObject({ provider: 'anthropic', fallbackUsed: true, usageCost: 3 }); expect(calls).toHaveLength(2); expect(await payload.findByID({ collection: 'integration-configurations', id: primary.id, overrideAccess: true })).toMatchObject({ health: 'unavailable', monthlyUsage: 2 }); expect(await payload.findByID({ collection: 'integration-configurations', id: fallback.id, overrideAccess: true })).toMatchObject({ health: 'connected', monthlyUsage: 3 })
    let contacted = false; await expect(executeConfiguredAIJob(payload, { provider: 'openai', input: 'over cap', estimatedCost: 9 }, { now, transport: async () => { contacted = true; return Response.json({}) } })).rejects.toThrow('AI_JOB_UNAVAILABLE'); expect(contacted).toBe(false)
  })

  it('serializes concurrent cap reservations so they cannot both contact a provider', async () => {
    const configuredRecord = await configured('openai', 'concurrent', 'concurrent-secret', { monthlyCap: 10, monthlyUsage: 0, usageMonth: '2026-10' })
    let contacted = 0
    const transport = async () => { contacted += 1; return Response.json({ output: [{ content: [{ type: 'output_text', text: 'reserved' }] }], usage: { total_tokens: 6 } }) }
    const jobs = await Promise.allSettled([
      executeConfiguredAIJob(payload, { provider: 'openai', input: 'first', estimatedCost: 6 }, { now, transport }),
      executeConfiguredAIJob(payload, { provider: 'openai', input: 'second', estimatedCost: 6 }, { now, transport }),
    ])
    expect(jobs.filter((job) => job.status === 'fulfilled')).toHaveLength(1)
    expect(contacted).toBe(1)
    expect(await payload.findByID({ collection: 'integration-configurations', id: configuredRecord.id, overrideAccess: true })).toMatchObject({ monthlyUsage: 6, monthlyCap: 10 })
  })

  it('does not retry or fall back from rejected and revoked credentials', async () => {
    const rejected = await configured('google-gemini', 'gemini-test', 'do-not-leak', { fallbackProvider: 'openrouter' }); await configured('openrouter', 'fallback', 'also-not-leaked'); const requests: Request[] = []
    await expect(executeConfiguredAIJob(payload, { provider: 'google-gemini', fallbackProvider: 'openrouter', input: 'private input', estimatedCost: 1 }, { now, transport: async request => { requests.push(request); return new Response('{}', { status: 401 }) } })).rejects.toThrow('AI_JOB_UNAVAILABLE'); expect(requests).toHaveLength(1); expect((await payload.findByID({ collection: 'integration-configurations', id: rejected.id, overrideAccess: true })).health).toBe('rejected')
    await payload.update({ collection: 'integration-configurations', id: rejected.id, data: { encryptedCredential: null, health: 'revoked' } as never, overrideAccess: true }); await expect(executeConfiguredAIJob(payload, { provider: 'google-gemini', fallbackProvider: 'openrouter', input: 'private input', estimatedCost: 1 }, { now, transport: async request => { requests.push(request); return Response.json({}) } })).rejects.toThrow('AI_JOB_UNAVAILABLE'); expect(requests).toHaveLength(1)
    const direct = await invokeProvider('openai', 'do-not-leak', 'model', 'prompt', 1, async () => new Response('{"error":"bad key"}', { status: 401 })); expect(direct).toEqual({ outcome: 'rejected' }); expect(JSON.stringify(direct)).not.toContain('do-not-leak')
  })
})
