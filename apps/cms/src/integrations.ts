import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export const integrationProviders = ['openai', 'anthropic', 'google-gemini', 'openrouter', 'mistral', 'azure-openai'] as const
export type IntegrationProvider = (typeof integrationProviders)[number]
export type ConnectionResult = { ok: boolean; code: 'connected' | 'unavailable' | 'rejected' }
export type ConnectionTransport = (input: { provider: IntegrationProvider; credential: string; model?: string | null; azureResourceEndpoint?: string | null; azureApiVersion?: string | null }) => Promise<ConnectionResult>
export type ConnectionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const CONNECTION_TIMEOUT_MS = 5_000
const CONNECTION_MAX_RESPONSE_BYTES = 64 * 1024

function key(): Buffer {
  const encoded = process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
  if (!encoded) throw new Error('INTEGRATION_CREDENTIAL_ENCRYPTION_KEY is required for integration credentials.')
  const value = Buffer.from(encoded, 'base64url')
  if (value.length !== 32) throw new Error('INTEGRATION_CREDENTIAL_ENCRYPTION_KEY must be a 32-byte base64url value.')
  return value
}

/** AES-GCM envelope. The master key is supplied only by the deployment runtime. */
export function encryptCredential(value: string, provider: IntegrationProvider): string {
  if (!value || Buffer.byteLength(value, 'utf8') > 16_384) throw new Error('Credential must contain 1 to 16384 bytes.')
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv); cipher.setAAD(Buffer.from(provider, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`
}

export function decryptCredential(envelope: string, provider: IntegrationProvider): string {
  if (!envelope.startsWith('v1.')) throw new Error('Credential envelope is invalid.')
  const value = Buffer.from(envelope.slice(3), 'base64url')
  if (value.length < 29) throw new Error('Credential envelope is invalid.')
  const decipher = createDecipheriv('aes-256-gcm', key(), value.subarray(0, 12)); decipher.setAAD(Buffer.from(provider, 'utf8')); decipher.setAuthTag(value.subarray(12, 28))
  return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
}

export const credentialFingerprint = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12)

/** No production provider is contacted by this foundation. Adapters inject this seam when approved. */
export async function testConnection(input: { provider: IntegrationProvider; encryptedCredential: string; model?: string | null; azureResourceEndpoint?: string | null; azureApiVersion?: string | null }, transport?: ConnectionTransport): Promise<ConnectionResult> {
  const credential = decryptCredential(input.encryptedCredential, input.provider)
  if (!transport) return { ok: false, code: 'unavailable' }
  try {
    const result = await transport({ provider: input.provider, credential, model: input.model, azureResourceEndpoint: input.azureResourceEndpoint, azureApiVersion: input.azureApiVersion })
    return result?.ok === true && result.code === 'connected' ? { ok: true, code: 'connected' } : result?.code === 'unavailable' ? { ok: false, code: 'unavailable' } : { ok: false, code: 'rejected' }
  }
  catch { return { ok: false, code: 'rejected' } }
}

function endpoint(provider: IntegrationProvider, model: string, credential: string, azureEndpoint?: string | null): { url: string; headers: Record<string, string> } | undefined {
  const encodedModel = encodeURIComponent(model)
  if (provider === 'openai') return { url: `https://api.openai.com/v1/models/${encodedModel}`, headers: { authorization: `Bearer ${credential}` } }
  if (provider === 'anthropic') return { url: `https://api.anthropic.com/v1/models/${encodedModel}`, headers: { 'x-api-key': credential, 'anthropic-version': '2023-06-01' } }
  if (provider === 'google-gemini') return { url: `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}`, headers: { 'x-goog-api-key': credential } }
  if (provider === 'mistral') return { url: `https://api.mistral.ai/v1/models/${encodedModel}`, headers: { authorization: `Bearer ${credential}` } }
  if (provider === 'azure-openai') {
    const resource = azureResourceEndpoint(azureEndpoint)
    return resource ? { url: `${resource}/openai/v1/models`, headers: { 'api-key': credential } } : undefined
  }
  const [author, slug, ...rest] = model.split('/')
  if (!author || !slug || rest.length) return undefined
  return { url: `https://openrouter.ai/api/v1/model/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`, headers: { authorization: `Bearer ${credential}` } }
}

async function drainBounded(response: Response) {
  if (!response.body) return
  const reader = response.body.getReader()
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return
      bytes += next.value.byteLength
      if (bytes > CONNECTION_MAX_RESPONSE_BYTES) return
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/** Explicit, non-billable provider metadata lookup used only by the Owner test action. */
export async function providerConnectionTransport(input: { provider: IntegrationProvider; credential: string; model?: string | null; azureResourceEndpoint?: string | null; azureApiVersion?: string | null }, fetcher: ConnectionFetch = fetch): Promise<ConnectionResult> {
  if (!input.model) return { ok: false, code: 'unavailable' }
  const target = endpoint(input.provider, input.model, input.credential, input.azureResourceEndpoint)
  if (!target) return { ok: false, code: 'unavailable' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS)
  const request = async (url: string, headers: Record<string, string>): Promise<ConnectionResult> => {
    const response = await fetcher(url, { method: 'GET', headers, signal: controller.signal, redirect: 'error' })
    await drainBounded(response)
    if (response.status === 401 || response.status === 403) return { ok: false, code: 'rejected' }
    return response.ok ? { ok: true, code: 'connected' } : { ok: false, code: 'unavailable' }
  }
  try {
    // OpenRouter's model catalog is public. Verify the key first, then check
    // the selected model so a public catalog response cannot validate a bad key.
    if (input.provider === 'openrouter') {
      const key = await request('https://openrouter.ai/api/v1/key', { authorization: `Bearer ${input.credential}` })
      if (!key.ok) return key
    }
    return await request(target.url, target.headers)
  } catch {
    return { ok: false, code: 'unavailable' }
  } finally { clearTimeout(timeout) }
}

export function publicIntegration(doc: Record<string, unknown>) {
  return {
    id: doc.id,
    provider: doc.provider,
    model: doc.model ?? null,
    azureResourceEndpoint: doc.azureResourceEndpoint ?? null,
    azureApiVersion: doc.azureApiVersion ?? null,
    fallbackProvider: doc.fallbackProvider ?? null,
    monthlyCapMicroUsd: doc.monthlyCapMicroUsd ?? null,
    monthlyUsageMicroUsd: doc.monthlyUsageMicroUsd ?? 0,
    usageMonth: doc.usageMonth ?? null,
    inputMicroUsdPerMillionTokens: doc.inputMicroUsdPerMillionTokens ?? null,
    outputMicroUsdPerMillionTokens: doc.outputMicroUsdPerMillionTokens ?? null,
    pricingSource: doc.pricingSource ?? null,
    pricingAsOf: doc.pricingAsOf ?? null,
    health: doc.health ?? 'unknown',
    testedAt: doc.testedAt ?? null,
    credentialConfigured: typeof doc.encryptedCredential === 'string' && doc.encryptedCredential.length > 0,
    credentialHint: typeof doc.credentialFingerprint === 'string' ? `configured • ${doc.credentialFingerprint}` : null,
  }
}

export function azureResourceEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 300) return undefined
  try {
    const url = new URL(value)
    // The resource endpoint is an Azure-controlled DNS name, not a caller
    // supplied request URL. Restricting it to one DNS label blocks paths,
    // userinfo, query tricks, IP literals, and arbitrary internal hosts.
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.openai\.azure\.com$/i.test(url.hostname)) return undefined
    return url.origin
  } catch { return undefined }
}
