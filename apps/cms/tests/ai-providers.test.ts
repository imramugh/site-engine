import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import sharp from 'sharp'

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
beforeAll(async () => { payload = await getPayload({ config }) }, 60_000)
beforeEach(async () => { const db = payload.db as unknown as { client: { execute: (query: string) => Promise<unknown> } }; await db.client.execute('DELETE FROM provider_usage_reservations'); await db.client.execute('DELETE FROM integration_configurations') })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })
async function configured(provider: 'openai' | 'anthropic' | 'google-gemini' | 'openrouter' | 'mistral' | 'azure-openai', model: string, credential: string, extra: Record<string, unknown> = {}) { return payload.create({ collection: 'integration-configurations', data: { provider, model, encryptedCredential: encryptCredential(credential, provider), credentialFingerprint: 'masked', health: 'unknown', ...pricing, ...extra } as never, overrideAccess: true }) }
const job = (provider: 'openai' | 'anthropic' | 'google-gemini' | 'openrouter' | 'mistral' | 'azure-openai', input = 'hello') => ({ provider, input, maxOutputTokens: 10 })

describe('ENG-023 provider monetary accounting', () => {
  it('sends a bounded image payload only to the configured vision provider', async () => {
    await configured('openai', 'gpt-test', 'vision-secret', { monthlyCapMicroUsd: 2_000_000 })
    let request: Request | undefined
    await expect(executeConfiguredAIJob(payload, { ...job('openai', 'Describe visible content.'), requiresImage: true, imageDataUrl: 'data:image/webp;base64,AAECAwQ=' }, { now, transport: async candidate => {
      request = candidate
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'A neutral image description.' }] }], usage: { input_tokens: 2, output_tokens: 3 } })
    } })).resolves.toMatchObject({ provider: 'openai', output: 'A neutral image description.' })
    expect(request?.url).toBe('https://api.openai.com/v1/responses')
    expect(await request?.json()).toMatchObject({ model: 'gpt-test', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Describe visible content.' }, { type: 'input_image', image_url: 'data:image/webp;base64,AAECAwQ=' }] }] })
    expect(request?.headers.get('authorization')).toBe('Bearer vision-secret')
  })

  it('reserves the reviewed 768px visual bound before transport, independent of compressed byte size', async () => {
    const image = await sharp({ create: { width: 768, height: 768, channels: 3, background: '#000000' } }).webp({ quality: 1 }).toBuffer()
    expect((await sharp(image).metadata())).toMatchObject({ width: 768, height: 768 })
    await configured('openai', 'gpt-4.1-mini', 'vision-secret', { monthlyCapMicroUsd: 2_100, monthlyUsageMicroUsd: 0, usageMonth: '2026-10' })
    let contacted = false
    const tinyFlat768 = `data:image/webp;base64,${image.toString('base64')}`
    await expect(executeConfiguredAIJob(payload, { ...job('openai'), requiresImage: true, imageDataUrl: tinyFlat768 }, { now, transport: async () => { contacted = true; return Response.json({}) } })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    expect(contacted).toBe(false)
  })

  it('fails closed for an unreviewed vision model before transport', async () => {
    await configured('openai', 'unreviewed-vision', 'vision-secret', { monthlyCapMicroUsd: 9_000_000 })
    let contacted = false
    await expect(executeConfiguredAIJob(payload, { ...job('openai'), requiresImage: true, imageDataUrl: 'data:image/webp;base64,AA==' }, { now, transport: async () => { contacted = true; return Response.json({}) } })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    expect(contacted).toBe(false)
  })

  it('bounds output for every provider and settles normalized token usage in micro-USD', async () => {
    const records = [await configured('openai', 'gpt-test', 'openai-secret'), await configured('anthropic', 'claude-test', 'anthropic-secret'), await configured('google-gemini', 'gemini test/model', 'gemini-secret'), await configured('openrouter', 'provider/model', 'router-secret'), await configured('mistral', 'mistral-small-latest', 'mistral-secret')]
    const observed: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const transport = async (request: Request) => { const body = await request.json() as Record<string, unknown>; observed.push({ url: request.url, headers: request.headers, body }); if (request.url.includes('openai.com')) return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'openai answer' }] }], usage: { input_tokens: 2, output_tokens: 3 } }); if (request.url.includes('anthropic.com')) return Response.json({ content: [{ type: 'text', text: 'anthropic answer' }], usage: { input_tokens: 2, output_tokens: 3 } }); if (request.url.includes('googleapis.com')) return Response.json({ candidates: [{ content: { parts: [{ text: 'gemini answer' }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } }); return Response.json({ choices: [{ message: { content: 'router answer' } }], usage: { prompt_tokens: 2, completion_tokens: 3, cost: 0.000001 } }) }
    for (const provider of ['openai', 'anthropic', 'google-gemini', 'openrouter', 'mistral'] as const) await expect(executeConfiguredAIJob(payload, job(provider), { transport, now })).resolves.toMatchObject({ provider, usageCostMicroUsd: 8 })
    expect(observed[0]).toMatchObject({ url: 'https://api.openai.com/v1/responses', body: { max_output_tokens: 10 } }); expect(observed[1]).toMatchObject({ url: 'https://api.anthropic.com/v1/messages', body: { max_tokens: 10 } }); expect(observed[2]).toMatchObject({ url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini%20test%2Fmodel:generateContent', body: { generationConfig: { maxOutputTokens: 10 } } }); expect(observed[3]).toMatchObject({ url: 'https://openrouter.ai/api/v1/chat/completions', body: { max_tokens: 10 } }); expect(observed[4]).toMatchObject({ url: 'https://api.mistral.ai/v1/chat/completions', body: { model: 'mistral-small-latest', max_tokens: 10 } }); expect(observed[4]!.headers.get('authorization')).toBe('Bearer mistral-secret')
    for (const record of records) { const saved = await payload.findByID({ collection: 'integration-configurations', id: record.id, overrideAccess: true }); expect(saved).toMatchObject({ monthlyUsageMicroUsd: 8 }); expect(publicIntegration(saved as unknown as Record<string, unknown>)).not.toHaveProperty('encryptedCredential') }
  })

  it('uses the Azure GA resource endpoint with deployment-as-model, settles usage, and never exposes its key', async () => {
    const secret = 'azure-key-that-must-not-leak'
    const record = await configured('azure-openai', 'reviewed-deployment', secret, { azureResourceEndpoint: 'https://reviewed-resource.openai.azure.com/', azureApiVersion: null, monthlyCapMicroUsd: 200 })
    const requests: Request[] = []
    await expect(executeConfiguredAIJob(payload, job('azure-openai', 'private prompt'), { now, transport: async request => {
      requests.push(request)
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'safe Azure response' }] }], usage: { input_tokens: 2, output_tokens: 3 } })
    } })).resolves.toMatchObject({ provider: 'azure-openai', output: 'safe Azure response', usageCostMicroUsd: 8, usageCostStatus: 'actual' })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://reviewed-resource.openai.azure.com/openai/v1/responses')
    expect(requests[0]!.headers.get('api-key')).toBe(secret)
    expect(requests[0]!.headers.get('authorization')).toBeNull()
    expect(await requests[0]!.json()).toMatchObject({ model: 'reviewed-deployment', max_output_tokens: 10 })
    const saved = await payload.findByID({ collection: 'integration-configurations', id: record.id, overrideAccess: true })
    const reservations = await payload.find({ collection: 'provider-usage-reservations', where: { configuration: { equals: record.id } }, overrideAccess: true })
    expect(JSON.stringify({ saved, reservations: reservations.docs, public: publicIntegration(saved as unknown as Record<string, unknown>) })).not.toContain(secret)
    expect(reservations.docs[0]).toMatchObject({ state: 'settled', settledMicroUsd: 8, configModel: 'reviewed-deployment' })
  })

  it('fails closed for invalid Azure resource URLs and preserves the cap when a snapshotted resource changes', async () => {
    for (const endpoint of ['http://reviewed-resource.openai.azure.com/', 'https://127.0.0.1/', 'https://reviewed-resource.openai.azure.com/openai/v1/responses', 'https://reviewed-resource.openai.azure.com/?target=internal', 'https://reviewed-resource.openai.azure.com.evil.test/']) {
      let calls = 0
      await expect(invokeProvider('azure-openai', 'secret', 'deployment', 'prompt', 10, async () => { calls += 1; return Response.json({}) }, 100, endpoint)).resolves.toEqual({ outcome: 'unavailable' })
      expect(calls).toBe(0)
    }
    const record = await configured('azure-openai', 'deployment', 'secret', { azureResourceEndpoint: 'https://reviewed-resource.openai.azure.com/', azureApiVersion: null })
    const snapshot = [{ id: record.id, provider: 'azure-openai' as const, model: 'deployment', credentialFingerprint: 'masked', monthlyCapMicroUsd: null, ...pricing, azureResourceEndpoint: 'https://reviewed-resource.openai.azure.com', azureApiVersion: null }]
    await payload.update({ collection: 'integration-configurations', id: record.id, data: { azureResourceEndpoint: 'https://rotated-resource.openai.azure.com' } as never, overrideAccess: true })
    let calls = 0
    await expect(executeConfiguredAIJob(payload, job('azure-openai'), { now, configurationSnapshot: snapshot, transport: async () => { calls += 1; return Response.json({}) } })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    expect(calls).toBe(0)
    expect((await payload.find({ collection: 'provider-usage-reservations', where: { configuration: { equals: record.id } }, overrideAccess: true })).docs).toHaveLength(0)
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
    const transport = async () => { contacted += 1; return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'reserved' }] }], usage: { input_tokens: 5, output_tokens: 10 } }) }
    const jobs = await Promise.allSettled([executeConfiguredAIJob(payload, job('openai'), { now, transport }), executeConfiguredAIJob(payload, job('openai'), { now, transport })])
    expect(jobs.filter((result) => result.status === 'fulfilled')).toHaveLength(1); expect(contacted).toBe(1)
    expect(await payload.findByID({ collection: 'integration-configurations', id: record.id, overrideAccess: true })).toMatchObject({ monthlyUsageMicroUsd: 25, monthlyCapMicroUsd: 200 })
  })

  it('keeps reservations for unknown usage and timeouts so a retry cannot reuse the cap', async () => {
    const record = await configured('openai', 'bounded', 'secret', { monthlyCapMicroUsd: 500, monthlyUsageMicroUsd: 0, usageMonth: '2026-10' })
    await expect(executeConfiguredAIJob(payload, job('openai'), { now, transport: async () => Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'unmetered' }] }], usage: { total_tokens: 1 } }) })).resolves.toMatchObject({ usageCostMicroUsd: null, usageCostStatus: 'reserved', reservedMicroUsd: expect.any(Number) })
    const afterUnknown = await payload.findByID({ collection: 'integration-configurations', id: record.id, overrideAccess: true })
    expect(afterUnknown.monthlyUsageMicroUsd).toBeGreaterThan(25)
    const unknownReservation = await payload.find({ collection: 'provider-usage-reservations', where: { configuration: { equals: record.id } }, overrideAccess: true })
    expect(unknownReservation.docs[0]).toMatchObject({ state: 'reserved', settledMicroUsd: null })
    let aborted = false
    await expect(executeConfiguredAIJob(payload, job('openai'), { now, timeoutMs: 5, transport: async request => new Promise((_, reject) => request.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })) })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    const afterTimeout = await payload.findByID({ collection: 'integration-configurations', id: record.id, overrideAccess: true })
    expect(aborted).toBe(true); expect(afterTimeout).toMatchObject({ health: 'unavailable' }); expect(afterTimeout.monthlyUsageMicroUsd).toBeGreaterThan(afterUnknown.monthlyUsageMicroUsd!)
  })

  it('does not erase an ambiguous reservation after the credential is revoked', async () => {
    const record = await configured('openai', 'revoked-after-request', 'secret', { monthlyCapMicroUsd: 500, monthlyUsageMicroUsd: 0, usageMonth: '2026-10' })
    await expect(executeConfiguredAIJob(payload, job('openai'), { now, transport: async () => {
      await payload.update({ collection: 'integration-configurations', id: record.id, data: { health: 'revoked' } as never, overrideAccess: true })
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'unmetered' }] }], usage: { total_tokens: 1 } })
    } })).resolves.toMatchObject({ output: 'unmetered' })
    const rows = await payload.find({ collection: 'provider-usage-reservations', where: { configuration: { equals: record.id } }, overrideAccess: true })
    expect(rows.docs).toHaveLength(1)
    expect(rows.docs[0]).toMatchObject({ state: 'reserved', settledMicroUsd: null })
    expect(await payload.findByID({ collection: 'integration-configurations', id: record.id, overrideAccess: true })).toMatchObject({ health: 'revoked' })
  })

  it('bounds a response body that never finishes decoding', async () => {
    const started = Date.now()
    await expect(invokeProvider('openai', 'secret', 'model', 'prompt', 10, async () => new Response(new ReadableStream({ start() {} })), 5)).resolves.toEqual({ outcome: 'unavailable' })
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('returns only final text parts and rejects reasoning-only provider responses', async () => {
    await expect(invokeProvider('openai', 'secret', 'model', 'prompt', 10, async () => Response.json({ output: [{ type: 'message', content: [{ type: 'reasoning', text: 'private' }, { type: 'output_text', text: 'final ' }, { type: 'output_text', text: 'answer' }] }], usage: { input_tokens: 1, output_tokens: 2 } }))).resolves.toMatchObject({ outcome: 'success', output: 'final answer' })
    await expect(invokeProvider('anthropic', 'secret', 'model', 'prompt', 10, async () => Response.json({ content: [{ type: 'thinking', text: 'private' }, { type: 'text', text: 'final ' }, { type: 'text', text: 'answer' }], usage: { input_tokens: 1, output_tokens: 2 } }))).resolves.toMatchObject({ outcome: 'success', output: 'final answer' })
    await expect(invokeProvider('google-gemini', 'secret', 'model', 'prompt', 10, async () => Response.json({ candidates: [{ content: { parts: [{ thought: true, text: 'private' }, { text: 'final ' }, { text: 'answer' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: 3 } }))).resolves.toMatchObject({ outcome: 'success', output: 'final answer' })
    await expect(invokeProvider('google-gemini', 'secret', 'model', 'prompt', 10, async () => Response.json({ candidates: [{ content: { parts: [{ thought: true, text: 'private' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0, thoughtsTokenCount: 3 } }))).resolves.toEqual({ outcome: 'unavailable' })
  })

  it('records actual usage above its reservation and closes the cap to later work', async () => {
    const record = await configured('openai', 'overrun', 'secret', { monthlyCapMicroUsd: 250, monthlyUsageMicroUsd: 0, usageMonth: '2026-10' })
    let contacted = 0
    const transport = async () => { contacted += 1; return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'expensive' }] }], usage: { input_tokens: 100, output_tokens: 100 } }) }
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

  it('settles a rotated configuration in its immutable reservation record without overwriting new credentials', async () => {
    const record = await configured('openai', 'old-model', 'old-secret', { monthlyCapMicroUsd: 500, monthlyUsageMicroUsd: 0, usageMonth: '2026-10' })
    await expect(executeConfiguredAIJob(payload, job('openai'), { now, transport: async () => {
      await payload.update({ collection: 'integration-configurations', id: record.id, data: { model: 'new-model', encryptedCredential: encryptCredential('new-secret', 'openai'), credentialFingerprint: 'new-fingerprint' } as never, overrideAccess: true })
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'old response' }] }], usage: { input_tokens: 2, output_tokens: 3 } })
    } })).resolves.toMatchObject({ output: 'old response' })
    const saved = await payload.findByID({ collection: 'integration-configurations', id: record.id, overrideAccess: true })
    expect(saved).toMatchObject({ model: 'new-model', credentialFingerprint: 'new-fingerprint' })
    expect(saved.monthlyUsageMicroUsd).toBe(8)
    const reservations = await payload.find({ collection: 'provider-usage-reservations', where: { configuration: { equals: record.id } }, overrideAccess: true })
    expect(reservations.docs).toHaveLength(1)
    expect(reservations.docs[0]).toMatchObject({ state: 'settled', settledMicroUsd: 8, configModel: 'old-model', credentialFingerprint: 'masked' })
  })

  it('keeps an old-month settlement in its original period while the new month remains projected', async () => {
    const record = await configured('openai', 'month-boundary', 'secret', {
      monthlyCapMicroUsd: 500,
      monthlyUsageMicroUsd: 0,
      usageMonth: '2026-10',
    });
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const oldJob = executeConfiguredAIJob(payload, job('openai'), {
      now: new Date('2026-10-31T23:59:59.000Z'),
      transport: async () => {
        entered?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return Response.json({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'october' }] }],
          usage: { input_tokens: 2, output_tokens: 3 },
        });
      },
    });
    await enteredPromise;
    await expect(
      executeConfiguredAIJob(payload, job('openai'), {
        now: new Date('2026-11-01T00:00:01.000Z'),
        transport: async () =>
          Response.json({
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'november' }] }],
            usage: { input_tokens: 2, output_tokens: 3 },
          }),
      }),
    ).resolves.toMatchObject({ usageCostMicroUsd: 8 });
    release?.();
    await expect(oldJob).resolves.toMatchObject({ usageCostMicroUsd: 8 });
    expect(
      await payload.findByID({
        collection: 'integration-configurations',
        id: record.id,
        overrideAccess: true,
      }),
    ).toMatchObject({ usageMonth: '2026-11', monthlyUsageMicroUsd: 8 });
    const rows = await payload.find({
      collection: 'provider-usage-reservations',
      where: { configuration: { equals: record.id } },
      sort: 'usageMonth',
      overrideAccess: true,
    });
    expect(rows.docs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          usageMonth: '2026-10',
          state: 'settled',
          settledMicroUsd: 8,
        }),
        expect.objectContaining({
          usageMonth: '2026-11',
          state: 'settled',
          settledMicroUsd: 8,
        }),
      ]),
    );
    await expect(
      payload.find({
        collection: 'provider-usage-reservations',
        overrideAccess: false,
      }),
    ).rejects.toThrow();
  });

  it('does not retry rejected credentials or disclose them from direct invocation', async () => {
    await configured('google-gemini', 'gemini-test', 'do-not-leak'); await configured('openrouter', 'fallback', 'also-not-leaked'); const requests: Request[] = []
    await expect(executeConfiguredAIJob(payload, { ...job('google-gemini'), fallbackProvider: 'openrouter' }, { now, transport: async request => { requests.push(request); return new Response('{}', { status: 401 }) } })).rejects.toThrow('AI_JOB_UNAVAILABLE'); expect(requests).toHaveLength(1)
    const direct = await invokeProvider('openai', 'do-not-leak', 'model', 'prompt', 10, async () => new Response('{"error":"bad key"}', { status: 401 })); expect(direct).toEqual({ outcome: 'rejected' }); expect(JSON.stringify(direct)).not.toContain('do-not-leak')
  })
})
