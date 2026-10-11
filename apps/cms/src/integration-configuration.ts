import { withPayloadTransaction } from './auth-transaction'
import { credentialFingerprint, encryptCredential, providerConnectionTransport, testConnection, type ConnectionTransport, type IntegrationProvider } from './integrations'
import { enqueueNotification } from './notification-settings'
import { normalizeProviderSettings, type ProviderSettings } from './provider-settings'

type PayloadLike = Parameters<typeof withPayloadTransaction>[0]
type AuditWrite = (input: { payload: PayloadLike; req: unknown; event: string; actor: string | undefined; provider: IntegrationProvider; detail?: Record<string, string> }) => Promise<void>

const defaultAuditWrite: AuditWrite = async ({ payload, req, event, actor, provider, detail }) => {
  await payload.create({ collection: 'audit-events', data: { event, actor, detail: { provider, ...detail } }, overrideAccess: true, req: req as never })
}

type StoredConfiguration = { id: string; provider: IntegrationProvider; model: string; providerSettings: ProviderSettings; encryptedCredential: string | null; credentialFingerprint: string | null; health?: string | null; testedAt?: string | null; updatedAt?: string | null }
function snapshot(record: Record<string, unknown>): StoredConfiguration | undefined {
  if (typeof record.id !== 'string' || !integrationProvider(record.provider) || typeof record.model !== 'string' || !record.encryptedCredential || typeof record.encryptedCredential !== 'string' || !record.credentialFingerprint || typeof record.credentialFingerprint !== 'string' || record.health === 'revoked') return undefined
  try { return { id: record.id, provider: record.provider, model: record.model, providerSettings: normalizeProviderSettings(record.provider, record.providerSettings), encryptedCredential: record.encryptedCredential, credentialFingerprint: record.credentialFingerprint, health: typeof record.health === 'string' ? record.health : null, testedAt: typeof record.testedAt === 'string' ? record.testedAt : null, updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null } } catch { return undefined }
}
const integrationProvider = (value: unknown): value is IntegrationProvider => typeof value === 'string' && ['openai', 'anthropic', 'google-gemini', 'openrouter', 'azure-openai', 'amazon-bedrock', 'mistral', 'openai-compatible'].includes(value)
const unchanged = (left: StoredConfiguration, right: StoredConfiguration) => left.id === right.id && left.provider === right.provider && left.model === right.model && JSON.stringify(left.providerSettings) === JSON.stringify(right.providerSettings) && left.encryptedCredential === right.encryptedCredential && left.credentialFingerprint === right.credentialFingerprint && left.updatedAt === right.updatedAt && right.health !== 'revoked'

export class IntegrationConfigurationStaleError extends Error { constructor() { super('INTEGRATION_CONFIGURATION_STALE') } }

export type PricingConfiguration = { monthlyCapMicroUsd: number | null; inputMicroUsdPerMillionTokens: number; outputMicroUsdPerMillionTokens: number; pricingSource: string; pricingAsOf: string }
export async function configureIntegration(payload: PayloadLike, input: { provider: IntegrationProvider; model: string; credential: string; fallbackProvider: IntegrationProvider | null; providerSettings?: unknown; pricing: PricingConfiguration; actor?: string }, auditWrite: AuditWrite = defaultAuditWrite) {
  if (input.fallbackProvider === input.provider) throw new Error('INTEGRATION_FALLBACK_SELF')
  const providerSettings = normalizeProviderSettings(input.provider, input.providerSettings)
  const data = { provider: input.provider, model: input.model, providerSettings, fallbackProvider: input.fallbackProvider, ...input.pricing, encryptedCredential: encryptCredential(input.credential, input.provider), credentialFingerprint: credentialFingerprint(input.credential), health: 'unknown' as const, testedAt: null }
  return withPayloadTransaction(payload, async (req) => {
    const existing = await payload.find({ collection: 'integration-configurations', where: { provider: { equals: input.provider } }, limit: 1, depth: 0, overrideAccess: true, req })
    const record = existing.docs[0] as unknown as Record<string, unknown> | undefined
    const saved = record ? await payload.update({ collection: 'integration-configurations', id: String(record.id), data: data as never, overrideAccess: true, req }) : await payload.create({ collection: 'integration-configurations', data: data as never, overrideAccess: true, req })
    await auditWrite({ payload, req, event: 'integration.credential_rotated', actor: input.actor, provider: input.provider })
    return { saved, created: !record }
  })
}

export async function revokeIntegration(payload: PayloadLike, input: { provider: IntegrationProvider; actor?: string }, auditWrite: AuditWrite = defaultAuditWrite) {
  return withPayloadTransaction(payload, async (req) => {
    const existing = await payload.find({ collection: 'integration-configurations', where: { provider: { equals: input.provider } }, limit: 1, depth: 0, overrideAccess: true, req })
    const record = existing.docs[0] as unknown as Record<string, unknown> | undefined
    if (!record) return undefined
    const saved = await payload.update({ collection: 'integration-configurations', id: String(record.id), data: { encryptedCredential: null, credentialFingerprint: null, health: 'revoked', testedAt: new Date().toISOString() }, overrideAccess: true, req })
    await auditWrite({ payload, req, event: 'integration.credential_revoked', actor: input.actor, provider: input.provider })
    return saved
  })
}

/**
 * Runs an explicit provider metadata check outside SQLite, then writes its
 * normalized result only when the encrypted configuration is unchanged.
 */
export async function testIntegrationConnection(payload: PayloadLike, input: { provider: IntegrationProvider; actor?: string; now?: Date }, transport: ConnectionTransport = providerConnectionTransport, auditWrite: AuditWrite = defaultAuditWrite) {
  const found = await payload.find({ collection: 'integration-configurations', where: { provider: { equals: input.provider } }, limit: 1, depth: 0, overrideAccess: true })
  const expected = found.docs[0] && snapshot(found.docs[0] as unknown as Record<string, unknown>)
  if (!expected) throw new IntegrationConfigurationStaleError()

  const result = await testConnection({ provider: expected.provider, encryptedCredential: expected.encryptedCredential!, model: expected.model, settings: expected.providerSettings }, transport)
  const testedAt = (input.now ?? new Date()).toISOString()
  return withPayloadTransaction(payload, async (req) => {
    const current = await payload.find({ collection: 'integration-configurations', where: { provider: { equals: input.provider } }, limit: 1, depth: 0, overrideAccess: true, req })
    const actual = current.docs[0] && snapshot(current.docs[0] as unknown as Record<string, unknown>)
    if (!actual || !unchanged(expected, actual)) throw new IntegrationConfigurationStaleError()
    const saved = await payload.update({ collection: 'integration-configurations', id: actual.id, data: { health: result.code, testedAt }, overrideAccess: true, req })
    await auditWrite({ payload, req, event: 'integration.connection_tested', actor: input.actor, provider: input.provider, detail: { health: result.code } })
    if (actual.health === 'connected' && ['unavailable', 'rejected'].includes(result.code)) {
      const transition = actual.testedAt ?? actual.updatedAt ?? 'connected'
      await payload.create({ collection: 'audit-events', data: { event: 'integration.outage', actor: input.actor, detail: { provider: input.provider, configuration: actual.id, health: result.code, transition } }, overrideAccess: true, req })
      await enqueueNotification(payload as never, req as never, { kind: 'publish-or-integration-failed', idempotencyKey: `integration-outage:${actual.id}:${transition}`, sourceType: 'integration-configuration', sourceID: actual.id, payload: { provider: input.provider, health: result.code, configuration: actual.id } })
    }
    return saved
  })
}
