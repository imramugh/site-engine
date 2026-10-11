import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import ipaddr from 'ipaddr.js'
import type { IntegrationProvider } from './integrations'
import { normalizeProviderSettings, type ProviderSettings } from './provider-settings'

export type AdapterRequest = { url: string; headers: Record<string, string>; body: Record<string, unknown> }
type Address = { address: string; family: number }
export type PinnedCompatibleDependencies = { resolve?: (hostname: string) => Promise<Address[]>; request?: (url: URL, options: import('node:https').RequestOptions & { autoSelectFamily: boolean }, body: Buffer) => Promise<Response> }

function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address)
    return parsed.kind() === 'ipv4'
      ? parsed.range() === 'unicast'
      : !(parsed as ipaddr.IPv6).isIPv4MappedAddress() && parsed.match(ipaddr.parseCIDR('2000::/3')) && parsed.range() === 'unicast'
  } catch { return false }
}
function compatibleOrigin(settings: ProviderSettings): string | undefined {
  const endpoint = settings.endpoint
  const allowed = (process.env.AI_COMPATIBLE_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (!endpoint || !allowed.includes(new URL(endpoint).origin)) return undefined
  const url = new URL(endpoint)
  if (ipaddr.isValid(url.hostname) || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) return undefined
  return endpoint
}
const chatBody = (model: string, input: string, maxOutputTokens: number, image?: string) => ({
  model,
  max_tokens: maxOutputTokens,
  messages: [{ role: 'user', content: image ? [{ type: 'text', text: input }, { type: 'image_url', image_url: { url: image } }] : input }],
})
const responseBody = (model: string, input: string, maxOutputTokens: number, image?: string) => ({
  model,
  max_output_tokens: maxOutputTokens,
  input: [{ role: 'user', content: [{ type: 'input_text', text: input }, ...(image ? [{ type: 'input_image', image_url: image }] : [])] }],
})

export function adapterRequest(provider: IntegrationProvider, credential: string, model: string, input: string, maxOutputTokens: number, image: string | undefined, rawSettings: ProviderSettings | undefined): AdapterRequest | undefined {
  let settings: ProviderSettings
  try { settings = normalizeProviderSettings(provider, rawSettings) } catch { return undefined }
  if (provider === 'azure-openai') return { url: `${settings.endpoint}/responses`, headers: { 'api-key': credential, 'content-type': 'application/json' }, body: responseBody(model, input, maxOutputTokens, image) }
  if (provider === 'amazon-bedrock') return { url: `https://bedrock-runtime.${settings.region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: { messages: [{ role: 'user', content: [{ text: input }, ...(image ? [{ image: { format: 'webp', source: { bytes: image.split(',', 2)[1] } } }] : [])] }], inferenceConfig: { maxTokens: maxOutputTokens } } }
  if (provider === 'mistral') return { url: 'https://api.mistral.ai/v1/chat/completions', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: chatBody(model, input, maxOutputTokens, image) }
  if (provider === 'openai-compatible') {
    const endpoint = compatibleOrigin(settings)
    return endpoint ? { url: `${endpoint}/chat/completions`, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: chatBody(model, input, maxOutputTokens, image) } : undefined
  }
  return undefined
}
export function adapterMetadataURL(provider: IntegrationProvider, model: string, rawSettings: ProviderSettings | undefined): string | undefined {
  let settings: ProviderSettings
  try { settings = normalizeProviderSettings(provider, rawSettings) } catch { return undefined }
  if (provider === 'azure-openai') return `${settings.endpoint}/models/${encodeURIComponent(model)}`
  if (provider === 'amazon-bedrock') {
    const profile = /^(?:us|eu|apac|global)\./.test(model) || model.startsWith('arn:')
    return profile ? `https://bedrock.${settings.region}.amazonaws.com/inference-profiles/${encodeURIComponent(model)}` : `https://bedrock.${settings.region}.amazonaws.com/foundation-models/${encodeURIComponent(model)}`
  }
  if (provider === 'mistral') return `https://api.mistral.ai/v1/models/${encodeURIComponent(model)}`
  if (provider === 'openai-compatible') { const endpoint = compatibleOrigin(settings); return endpoint && `${endpoint}/models/${encodeURIComponent(model)}` }
  return undefined
}
export function adapterOutput(provider: IntegrationProvider, body: Record<string, unknown>): { output: string; inputTokens?: unknown; outputTokens?: unknown } | undefined {
  if (provider === 'azure-openai') {
    const output = Array.isArray(body.output) ? body.output.flatMap(item => Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content as Array<Record<string, unknown>> : []).filter(item => item.type === 'output_text').map(item => typeof item.text === 'string' ? item.text : '').join('') : ''
    const usage = body.usage as Record<string, unknown> | undefined
    return output ? { output, inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens } : undefined
  }
  if (provider === 'amazon-bedrock') {
    const content = ((body.output as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined)?.content
    const output = Array.isArray(content) ? content.map(item => typeof (item as Record<string, unknown>).text === 'string' ? (item as Record<string, unknown>).text : '').join('') : ''
    const usage = body.usage as Record<string, unknown> | undefined
    return output ? { output, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens } : undefined
  }
  if (provider === 'mistral' || provider === 'openai-compatible') {
    const message = Array.isArray(body.choices) ? (body.choices[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined : undefined
    const usage = body.usage as Record<string, unknown> | undefined
    return typeof message?.content === 'string' && message.content ? { output: message.content, inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens } : undefined
  }
  return undefined
}

/** Resolves every answer, rejects non-public addresses, and pins the selected address for the TLS request. */
export async function pinnedCompatibleFetch(request: Request, dependencies: PinnedCompatibleDependencies = {}): Promise<Response> {
  const url = new URL(request.url)
  const addresses = dependencies.resolve ? await dependencies.resolve(url.hostname) : (await lookup(url.hostname, { all: true, verbatim: true })).map(item => ({ address: item.address, family: item.family }))
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('compatible_endpoint_unsafe')
  if (request.signal.aborted) throw new Error('aborted')
  const body = Buffer.from(await request.arrayBuffer())
  const options = { method: request.method, headers: Object.fromEntries(request.headers), autoSelectFamily: false, lookup: (_host: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => callback(null, addresses[0]!.address, addresses[0]!.family), servername: url.hostname } as import('node:https').RequestOptions & { autoSelectFamily: boolean }
  if (dependencies.request) return dependencies.request(url, options, body)
  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(url, options, incoming => {
      const chunks: Buffer[] = []; let size = 0
      incoming.on('data', chunk => { size += chunk.length; if (size > 1_048_576) req.destroy(new Error('compatible_response_too_large')); else chunks.push(Buffer.from(chunk)) })
      incoming.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 502, headers: incoming.headers as HeadersInit })))
    })
    req.once('error', reject)
    if (request.signal) request.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
    req.end(body)
  })
}
