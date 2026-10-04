import { createHash, randomUUID } from 'node:crypto'
import type { Payload } from 'payload'
import { withPayloadTransaction } from './auth-transaction'
import type { IntegrationProvider } from './integrations'

const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value)
const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex')
export type JobInput = { provider: IntegrationProvider; fallbackProvider?: IntegrationProvider | null; input: string; maxOutputTokens: number; idempotencyKey: string }
export async function enqueueConfiguredAIJob(payload: Payload, actor: string, input: JobInput) {
  const request = { provider: input.provider, fallbackProvider: input.fallbackProvider ?? null, input: input.input, maxOutputTokens: input.maxOutputTokens }
  const requestDigest = digest(request)
  for (let attempt = 0; attempt < 8; attempt += 1) try { return await withPayloadTransaction(payload, async req => {
    const existing = await payload.find({ collection: 'configured-ai-jobs', where: { idempotencyKey: { equals: input.idempotencyKey } }, limit: 1, depth: 0, overrideAccess: true, req })
    if (existing.docs[0]) { const job = existing.docs[0] as unknown as { requestDigest: string }; if (job.requestDigest !== requestDigest) throw new Error('IDEMPOTENCY_KEY_REUSED'); return { job: existing.docs[0], created: false } }
    const configurations = await payload.find({ collection: 'integration-configurations', where: { provider: { in: [input.provider, input.fallbackProvider].filter(Boolean) } }, limit: 2, depth: 0, overrideAccess: true, req })
    const snapshot = configurations.docs.map((config: any) => ({ id: config.id, provider: config.provider, model: config.model, credentialFingerprint: config.credentialFingerprint ?? null, inputMicroUsdPerMillionTokens: config.inputMicroUsdPerMillionTokens, outputMicroUsdPerMillionTokens: config.outputMicroUsdPerMillionTokens, pricingSource: config.pricingSource, pricingAsOf: config.pricingAsOf }))
    if (!snapshot.some((config: any) => config.provider === input.provider)) throw new Error('AI_JOB_UNAVAILABLE')
    const job = await payload.create({ collection: 'configured-ai-jobs', data: { actor, idempotencyKey: input.idempotencyKey, requestDigest, ...request, configurationSnapshot: snapshot, state: 'queued' } as never, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'ai.job_enqueued', actor, detail: { job: job.id, provider: input.provider, fallbackProvider: input.fallbackProvider ?? null } }, overrideAccess: true, req })
    return { job, created: true }
  }) } catch (error) { if (attempt === 7 || !(error instanceof Error) || !error.message.includes('SQLITE_BUSY')) throw error
    await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1))) }
  throw new Error('AI_JOB_UNAVAILABLE')
}
