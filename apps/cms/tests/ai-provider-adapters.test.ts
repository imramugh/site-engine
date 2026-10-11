import { afterEach, describe, expect, it } from 'vitest'
import { adapterMetadataURL, adapterRequest, compatibleResponse, pinnedCompatibleFetch } from '../src/ai-provider-adapters'
import { invokeProvider } from '../src/ai-providers'
import { normalizeProviderSettings } from '../src/provider-settings'
import type { IntegrationProvider } from '../src/integrations'

const settings: Record<IntegrationProvider, object> = {
  'azure-openai': { endpoint: 'https://demo.openai.azure.com', imageInput: true, imageInputTokenLimit: 10_000 },
  'amazon-bedrock': { region: 'us-east-1', imageInput: true, imageInputTokenLimit: 10_000 },
  mistral: { imageInput: true, imageInputTokenLimit: 10_000 },
  'openai-compatible': { endpoint: 'https://compat.example.test/api/v1', imageInput: true, imageInputTokenLimit: 10_000 },
  openai: {}, anthropic: {}, 'google-gemini': {}, openrouter: {},
}
afterEach(() => { delete process.env.AI_COMPATIBLE_ALLOWED_ORIGINS })
const output = (provider: IntegrationProvider) => provider === 'azure-openai'
  ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 2, output_tokens: 3 } }
  : provider === 'amazon-bedrock'
    ? { output: { message: { content: [{ text: 'ok' }] } }, usage: { inputTokens: 2, outputTokens: 3 } }
    : { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }

describe('ENG-027 provider adapters', () => {
  it.each(['azure-openai', 'amazon-bedrock', 'mistral', 'openai-compatible'] as const)('serializes %s images and normalized usage', async provider => {
    process.env.AI_COMPATIBLE_ALLOWED_ORIGINS = 'https://compat.example.test'
    let request: Request | undefined
    const result = await invokeProvider(provider, 'secret', 'model/id', 'prompt', 9, async value => {
      request = value
      return Response.json(output(provider))
    }, 1_000, 'data:image/webp;base64,AA==', settings[provider])
    expect(result).toMatchObject({ outcome: 'success', output: 'ok', usage: { inputTokens: 2, outputTokens: 3 } })
    expect(JSON.stringify(await request!.json())).toContain('AA==')
    expect(request!.url).not.toContain('secret')
  })
  it('rejects unallowlisted endpoints and invalid reviewed image caps before transport', async () => {
    await expect(invokeProvider('openai-compatible', 'secret', 'model', 'prompt', 1, async () => Response.json({}), 1_000, undefined, { endpoint: 'https://not-allowed.example', imageInput: false })).resolves.toEqual({ outcome: 'unavailable' })
    await expect(invokeProvider('mistral', 'secret', 'model', 'prompt', 1, async () => Response.json({}), 1_000, undefined, { imageInput: true, imageInputTokenLimit: 0 })).resolves.toEqual({ outcome: 'unavailable' })
  })
  it.each(['azure-openai', 'amazon-bedrock', 'mistral', 'openai-compatible'] as const)('does not contact any fallback endpoint for invalid %s settings', async provider => {
    let calls = 0
    await expect(invokeProvider(provider, 'secret', 'model', 'prompt', 1, async () => { calls++; return Response.json({}) }, 1_000, undefined, {})).resolves.toEqual({ outcome: 'unavailable' })
    expect(calls).toBe(0)
  })
  it('keeps Azure settings idempotent and compatible base paths', () => {
    const azure = normalizeProviderSettings('azure-openai', settings['azure-openai'])
    expect(normalizeProviderSettings('azure-openai', azure)).toEqual(azure)
    process.env.AI_COMPATIBLE_ALLOWED_ORIGINS = 'https://compat.example.test'
    expect(adapterRequest('openai-compatible', 'secret', 'model', 'p', 1, undefined, settings['openai-compatible'])?.url).toBe('https://compat.example.test/api/v1/chat/completions')
  })
  it('uses correct Bedrock foundation and inference-profile metadata routes', () => {
    expect(adapterMetadataURL('amazon-bedrock', 'us.anthropic.claude-3', settings['amazon-bedrock'])).toContain('/inference-profiles/us.anthropic.claude-3')
    expect(adapterMetadataURL('amazon-bedrock', 'arn:aws:bedrock:us-east-1::foundation-model/x', settings['amazon-bedrock'])).toContain('/foundation-models/')
    expect(adapterMetadataURL('amazon-bedrock', 'arn:aws:bedrock:us-east-1:123:inference-profile/x', settings['amazon-bedrock'])).toContain('/inference-profiles/')
    expect(adapterMetadataURL('amazon-bedrock', 'arn:aws:bedrock:us-east-1:123:agent/x', settings['amazon-bedrock'])).toBeUndefined()
  })
  it('pins a public resolved compatible address and rejects private DNS answers', async () => {
    let selected: string | undefined
    await pinnedCompatibleFetch(new Request('https://compat.example.test/api', { method: 'POST' }), { resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: async (_url, options) => { options.lookup?.('compat.example.test', {}, (_error, address) => { selected = typeof address === 'string' ? address : '' }); return Response.json({ ok: true }) } })
    expect(selected).toBe('8.8.8.8')
    await expect(pinnedCompatibleFetch(new Request('https://compat.example.test/api'), { resolve: async () => [{ address: '127.0.0.1', family: 4 }] })).rejects.toThrow('compatible_endpoint_unsafe')
  })
  it('rejects unsupported Bedrock image MIME before transport', async () => {
    let calls = 0
    await expect(invokeProvider('amazon-bedrock', 'secret', 'model', 'p', 1, async () => { calls++; return Response.json({}) }, 1_000, 'data:image/gif;base64,AA==', settings['amazon-bedrock'])).resolves.toEqual({ outcome: 'unavailable' })
    expect(calls).toBe(0)
  })
  it('constructs bounded native compatible responses safely for empty and malformed headers', async () => {
    expect(await compatibleResponse(204, { 'x-array': ['a', 'b'], skipped: undefined }, Buffer.from('ignored')).text()).toBe('')
    expect(compatibleResponse(200, { 'x-array': ['a', 'b'], skipped: undefined }, Buffer.from('body')).headers.get('x-array')).toBe('a, b')
  })
  it('does not open a pinned connection after cancellation or mixed DNS answers', async () => {
    const controller = new AbortController(); let calls = 0
    const waiting = pinnedCompatibleFetch(new Request('https://compat.example.test/api', { signal: controller.signal }), { resolve: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return [{ address: '8.8.8.8', family: 4 }] }, request: async () => { calls++; return Response.json({}) } })
    controller.abort()
    await expect(waiting).rejects.toThrow('aborted')
    await expect(pinnedCompatibleFetch(new Request('https://compat.example.test/api'), { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '::ffff:127.0.0.1', family: 6 }], request: async () => { calls++; return Response.json({}) } })).rejects.toThrow('compatible_endpoint_unsafe')
    expect(calls).toBe(0)
  })

})
