import { withPayloadTransaction } from './auth-transaction'
import { credentialFingerprint, encryptCredential, type IntegrationProvider } from './integrations'

type PayloadLike = Parameters<typeof withPayloadTransaction>[0]
type AuditWrite = (input: { payload: PayloadLike; req: unknown; event: string; actor: string | undefined; provider: IntegrationProvider }) => Promise<void>

const defaultAuditWrite: AuditWrite = async ({ payload, req, event, actor, provider }) => {
  await payload.create({ collection: 'audit-events', data: { event, actor, detail: { provider } }, overrideAccess: true, req: req as never })
}

export async function configureIntegration(payload: PayloadLike, input: { provider: IntegrationProvider; model: string; credential: string; fallbackProvider: IntegrationProvider | null; monthlyCap: number | null; actor?: string }, auditWrite: AuditWrite = defaultAuditWrite) {
  const data = { provider: input.provider, model: input.model, fallbackProvider: input.fallbackProvider, monthlyCap: input.monthlyCap, encryptedCredential: encryptCredential(input.credential, input.provider), credentialFingerprint: credentialFingerprint(input.credential), health: 'unknown' as const, testedAt: null }
  return withPayloadTransaction(payload, async (req) => {
    const existing = await payload.find({ collection: 'integration-configurations', where: { provider: { equals: input.provider } }, limit: 1, depth: 0, overrideAccess: true, req })
    const record = existing.docs[0] as unknown as Record<string, unknown> | undefined
    const saved = record ? await payload.update({ collection: 'integration-configurations', id: String(record.id), data, overrideAccess: true, req }) : await payload.create({ collection: 'integration-configurations', data, overrideAccess: true, req })
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
