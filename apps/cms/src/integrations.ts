import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export const integrationProviders = ['openai', 'anthropic', 'google-gemini', 'openrouter'] as const
export type IntegrationProvider = (typeof integrationProviders)[number]
export type ConnectionResult = { ok: boolean; code: 'connected' | 'unavailable' | 'rejected' }
export type ConnectionTransport = (input: { provider: IntegrationProvider; credential: string; model?: string | null }) => Promise<ConnectionResult>

function key(): Buffer {
  const encoded = process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
  if (!encoded) throw new Error('INTEGRATION_CREDENTIAL_ENCRYPTION_KEY is required for integration credentials.')
  const value = Buffer.from(encoded, 'base64url')
  if (value.length !== 32) throw new Error('INTEGRATION_CREDENTIAL_ENCRYPTION_KEY must be a 32-byte base64url value.')
  return value
}

/** AES-GCM envelope. The master key is supplied only by the deployment runtime. */
export function encryptCredential(value: string): string {
  if (!value || Buffer.byteLength(value, 'utf8') > 16_384) throw new Error('Credential must contain 1 to 16384 bytes.')
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`
}

export function decryptCredential(envelope: string): string {
  if (!envelope.startsWith('v1.')) throw new Error('Credential envelope is invalid.')
  const value = Buffer.from(envelope.slice(3), 'base64url')
  if (value.length < 29) throw new Error('Credential envelope is invalid.')
  const decipher = createDecipheriv('aes-256-gcm', key(), value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28))
  return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
}

export const credentialFingerprint = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12)

/** No production provider is contacted by this foundation. Adapters inject this seam when approved. */
export async function testConnection(input: { provider: IntegrationProvider; encryptedCredential: string; model?: string | null }, transport?: ConnectionTransport): Promise<ConnectionResult> {
  const credential = decryptCredential(input.encryptedCredential)
  if (!transport) return { ok: false, code: 'unavailable' }
  try { return await transport({ provider: input.provider, credential, model: input.model }) }
  catch { return { ok: false, code: 'rejected' } }
}

export function publicIntegration(doc: Record<string, unknown>) {
  return {
    id: doc.id,
    provider: doc.provider,
    model: doc.model ?? null,
    fallbackProvider: doc.fallbackProvider ?? null,
    monthlyCap: doc.monthlyCap ?? null,
    health: doc.health ?? 'unknown',
    testedAt: doc.testedAt ?? null,
    credentialConfigured: typeof doc.encryptedCredential === 'string' && doc.encryptedCredential.length > 0,
    credentialHint: typeof doc.credentialFingerprint === 'string' ? `configured • ${doc.credentialFingerprint}` : null,
  }
}
