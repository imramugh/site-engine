import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import ipaddr from 'ipaddr.js'
import type { IntegrationProvider } from './integrations'
import { normalizeProviderSettings, type ProviderSettings } from './provider-settings'

export const configurableAdapterProviders = new Set<IntegrationProvider>(['azure-openai', 'amazon-bedrock', 'mistral', 'openai-compatible'])
export const isConfigurableAdapter = (provider: IntegrationProvider) => configurableAdapterProviders.has(provider)

export type AdapterRequest = { url: string; headers: Record<string, string>; body: Record<string, unknown> }
type Address = { address: string; family: number }

export function compatibleResponse(status: number, headers: Record<string, string | string[] | number | undefined>, body: Buffer): Response {
  const safeHeaders = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string' || typeof value === 'number') safeHeaders.set(name, String(value))
    else if (Array.isArray(value)) safeHeaders.set(name, value.join(', '))
  }
  return new Response([204, 205, 304].includes(status) ? null : body, { status, headers: safeHeaders })
}
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
function bedrockImage(image: string): Record<string, unknown> | undefined {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image)
  return match ? { image: { format: match[1] === 'jpeg' ? 'jpeg' : match[1], source: { bytes: match[2] } } } : undefined
}
const responseBody = (model: string, input: string, maxOutputTokens: number, image?: string) => ({
  model,
  max_output_tokens: maxOutputTokens,
  input: [{ role: 'user', content: [{ type: 'input_text', text: input }, ...(image ? [{ type: 'input_image', image_url: image }] : [])] }],
})

export function adapterRequest(provider: IntegrationProvider, credential: string, model: string, input: string, maxOutputTokens: number, image: string | undefined, rawSettings: ProviderSettings | undefined): AdapterRequest | undefined {
  let settings: ProviderSettings
  try { settings = normalizeProviderSettings(provider, rawSettings) } catch { return undefined }
  if (provider === 'azure-openai') return { url: `${settings.endpoint}/responses`, headers: { 'api-key': credential, 'content-type': 'application/json' }, body: responseBody(model, input, maxOutputTokens, image) }
  if (provider === 'amazon-bedrock') {
    const parsedImage = image ? bedrockImage(image) : undefined
    if (image && !parsedImage) return undefined
    const suffix = settings.region?.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'
    return { url: `https://bedrock-runtime.${settings.region}.${suffix}/model/${encodeURIComponent(model)}/converse`, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: { messages: [{ role: 'user', content: [{ text: input }, ...(parsedImage ? [parsedImage] : [])] }], inferenceConfig: { maxTokens: maxOutputTokens } } }
  }
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
    const suffix = settings.region?.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'
    const profile = /^(?:us|eu|apac|global)\./.test(model) || model.includes(':inference-profile/') || model.includes(':application-inference-profile/')
    if (model.startsWith('arn:') && !profile && !model.includes(':foundation-model/')) return undefined
    return profile ? `https://bedrock.${settings.region}.${suffix}/inference-profiles/${encodeURIComponent(model)}` : `https://bedrock.${settings.region}.${suffix}/foundation-models/${encodeURIComponent(model)}`
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
  if (request.signal.aborted) throw new Error('aborted')
  const options = { method: request.method, headers: Object.fromEntries(request.headers), autoSelectFamily: false, lookup: (_host: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => callback(null, addresses[0]!.address, addresses[0]!.family), servername: url.hostname } as import('node:https').RequestOptions & { autoSelectFamily: boolean }
  if (dependencies.request) return dependencies.request(url, options, body)
  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(url, options, incoming => {
      if ((incoming.statusCode ?? 500) >= 300 && (incoming.statusCode ?? 500) < 400) { incoming.destroy(); req.destroy(); reject(new Error('compatible_redirect_rejected')); return }
      const chunks: Buffer[] = []; let size = 0
      incoming.on('data', chunk => { size += chunk.length; if (size > 1_048_576) req.destroy(new Error('compatible_response_too_large')); else chunks.push(Buffer.from(chunk)) })
      incoming.once('error', reject)
      incoming.on('end', () => {
        try { resolve(compatibleResponse(incoming.statusCode ?? 502, incoming.headers, Buffer.concat(chunks))) }
        catch (error) { reject(error) }
      })
    })
    const abort = () => req.destroy(new Error('aborted'))
    req.once('error', error => { request.signal.removeEventListener('abort', abort); reject(error) })
    req.once('close', () => request.signal.removeEventListener('abort', abort))
    if (request.signal.aborted) { abort(); return }
    request.signal.addEventListener('abort', abort, { once: true })
    req.end(body)
  })
}
