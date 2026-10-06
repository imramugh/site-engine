import { createHash } from 'node:crypto'
import type { Payload } from 'payload'
import { withPayloadTransaction } from './auth-transaction'
import type { IntegrationProvider } from './integrations'

const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value)
const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex')
export type JobInput = { provider: IntegrationProvider; model?: string; fallbackProvider?: IntegrationProvider | null; input: string; imageDataUrl?: string; maxOutputTokens: number; idempotencyKey: string }
export async function enqueueConfiguredAIJob(payload: Payload, actor: string, input: JobInput) {
  const request = { provider: input.provider, model: input.model ?? null, fallbackProvider: input.fallbackProvider ?? null, input: input.input, imageDataUrl: input.imageDataUrl ?? null, maxOutputTokens: input.maxOutputTokens }
  const requestDigest = digest(request)
  for (let attempt = 0; attempt < 8; attempt += 1) try { return await withPayloadTransaction(payload, async req => {
    const existing = await payload.find({ collection: 'configured-ai-jobs', where: { idempotencyKey: { equals: input.idempotencyKey } }, limit: 1, depth: 0, overrideAccess: true, req })
    if (existing.docs[0]) { const job = existing.docs[0] as unknown as { requestDigest: string; actor: string | { id?: string } }; const actorID = typeof job.actor === 'string' ? job.actor : job.actor?.id; if (actorID !== actor || job.requestDigest !== requestDigest) throw new Error('IDEMPOTENCY_KEY_REUSED'); return { job: existing.docs[0], created: false } }
    const requiredProviders = [...new Set([input.provider, input.fallbackProvider].filter((value): value is IntegrationProvider => Boolean(value)))]
    const configurations = await payload.find({ collection: 'integration-configurations', where: { provider: { in: requiredProviders } }, limit: requiredProviders.length, depth: 0, overrideAccess: true, req })
    const valid = (config: any) => typeof config.model === 'string' && Boolean(config.model.trim()) && typeof config.encryptedCredential === 'string' && Boolean(config.encryptedCredential.trim()) && typeof config.credentialFingerprint === 'string' && Boolean(config.credentialFingerprint.trim()) && Number.isSafeInteger(config.inputMicroUsdPerMillionTokens) && config.inputMicroUsdPerMillionTokens >= 0 && Number.isSafeInteger(config.outputMicroUsdPerMillionTokens) && config.outputMicroUsdPerMillionTokens >= 0 && typeof config.pricingSource === 'string' && Boolean(config.pricingSource.trim()) && typeof config.pricingAsOf === 'string' && Number.isFinite(Date.parse(config.pricingAsOf))
    const byProvider = new Map(configurations.docs.filter(valid).map((config: any) => [config.provider, config]))
    if (requiredProviders.some((provider) => !byProvider.has(provider)) || (input.model && byProvider.get(input.provider)?.model !== input.model)) throw new Error('AI_JOB_UNAVAILABLE')
    const snapshot = requiredProviders.map((provider) => { const config: any = byProvider.get(provider); return { id: config.id, provider: config.provider, model: config.model, credentialFingerprint: config.credentialFingerprint, monthlyCapMicroUsd: config.monthlyCapMicroUsd ?? null, inputMicroUsdPerMillionTokens: config.inputMicroUsdPerMillionTokens, outputMicroUsdPerMillionTokens: config.outputMicroUsdPerMillionTokens, pricingSource: config.pricingSource, pricingAsOf: new Date(config.pricingAsOf).toISOString() } })
    const job = await payload.create({ collection: 'configured-ai-jobs', data: { actor, idempotencyKey: input.idempotencyKey, requestDigest, ...request, configurationSnapshot: snapshot, state: 'queued' } as never, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'ai.job_enqueued', actor, detail: { job: job.id, provider: input.provider, fallbackProvider: input.fallbackProvider ?? null } }, overrideAccess: true, req })
    return { job, created: true }
  }) } catch (error) { if (attempt === 7 || !(error instanceof Error) || !error.message.includes('SQLITE_BUSY')) throw error
    await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1))) }
  throw new Error('AI_JOB_UNAVAILABLE')
}
