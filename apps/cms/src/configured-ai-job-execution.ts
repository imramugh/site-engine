import { createHash } from 'node:crypto'
import type { Payload } from 'payload'
import { executeConfiguredAIJob, type AIConfigurationSnapshot, type ProviderFetch } from './ai-providers'
import { beginConfiguredAIJob, claimConfiguredAIJob, completeConfiguredAIJob, failUnbegunConfiguredAIJob, manualReviewConfiguredAIJob, renewConfiguredAIJob } from './configured-ai-job-lifecycle'
import type { IntegrationProvider } from './integrations'

type StoredJob = { id: string; state: string; leaseToken?: string | null; dispatchStartedAt?: string | null; provider: IntegrationProvider; fallbackProvider?: IntegrationProvider | null; input: string; maxOutputTokens: number; configurationSnapshot: unknown }
export type ClaimedConfiguredAIJob = { job: StoredJob; leaseToken: string }
export type ConfiguredAIExecutionOptions = { transport: ProviderFetch; now?: Date; clock?: () => Date; timeoutMs?: number }

const providers = new Set<IntegrationProvider>(['openai', 'anthropic', 'google-gemini', 'openrouter'])
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export const configuredAIReservationKey = (jobID: string, provider: IntegrationProvider) => createHash('sha256').update(`${jobID}:${provider}`).digest('hex').slice(0, 36)
function snapshots(value: unknown): AIConfigurationSnapshot[] | undefined {
  if (!Array.isArray(value) || value.length < 1) return undefined
  const parsed = value.map((raw): AIConfigurationSnapshot | undefined => {
    if (!raw || typeof raw !== 'object') return undefined
    const candidate = raw as Record<string, unknown>
    if (typeof candidate.id !== 'string' || !providers.has(candidate.provider as IntegrationProvider) || typeof candidate.model !== 'string' || !candidate.model || typeof candidate.credentialFingerprint !== 'string' || !candidate.credentialFingerprint || (candidate.monthlyCapMicroUsd !== null && !integer(candidate.monthlyCapMicroUsd)) || !integer(candidate.inputMicroUsdPerMillionTokens) || !integer(candidate.outputMicroUsdPerMillionTokens) || typeof candidate.pricingSource !== 'string' || !candidate.pricingSource || typeof candidate.pricingAsOf !== 'string' || !Number.isFinite(Date.parse(candidate.pricingAsOf))) return undefined
    return candidate as unknown as AIConfigurationSnapshot
  })
  return parsed.every(Boolean) && new Set(parsed.map(item => item!.provider)).size === parsed.length ? parsed as AIConfigurationSnapshot[] : undefined
}
async function snapshotsStillCurrent(payload: Payload, snapshot: AIConfigurationSnapshot[]): Promise<boolean> {
  for (const expected of snapshot) {
    try {
      const current = await payload.findByID({ collection: 'integration-configurations', id: expected.id, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
      if (current.provider !== expected.provider || current.model !== expected.model || current.credentialFingerprint !== expected.credentialFingerprint || !current.encryptedCredential || current.health === 'revoked' || (current.monthlyCapMicroUsd ?? null) !== expected.monthlyCapMicroUsd || current.inputMicroUsdPerMillionTokens !== expected.inputMicroUsdPerMillionTokens || current.outputMicroUsdPerMillionTokens !== expected.outputMicroUsdPerMillionTokens || current.pricingSource !== expected.pricingSource || current.pricingAsOf !== expected.pricingAsOf) return false
    } catch { return false }
  }
  return true
}

/**
 * Executes one claimed CMS job. The durable begin transition is intentionally
 * immediately before the provider request; every error after that point is
 * manual review because a provider may already have accepted the request.
 */
export async function executeClaimedConfiguredAIJob(payload: Payload, claim: ClaimedConfiguredAIJob, options: ConfiguredAIExecutionOptions) {
  const clock = options.clock ?? (() => options.now ?? new Date())
  const expectedToken = claim.leaseToken
  const job = await payload.findByID({ collection: 'configured-ai-jobs', id: claim.job.id, depth: 0, overrideAccess: true }) as unknown as StoredJob
  const snapshot = snapshots(job.configurationSnapshot)
  if (!job.leaseToken || expectedToken !== job.leaseToken || job.state !== 'running') throw new Error('LEASE_INVALID')
  if (job.dispatchStartedAt) {
    await manualReviewConfiguredAIJob(payload, job.id, 'DISPATCH_RECOVERY_REQUIRED', expectedToken)
    throw new Error('AI_JOB_UNAVAILABLE')
  }
  if (!snapshot) {
    await failUnbegunConfiguredAIJob(payload, job.id, expectedToken, 'CONFIGURATION_SNAPSHOT_INVALID', clock().getTime())
    throw new Error('AI_JOB_UNAVAILABLE')
  }
  const required = [job.provider, job.fallbackProvider].filter((provider): provider is IntegrationProvider => Boolean(provider))
  if (required.some(provider => !snapshot.some(item => item.provider === provider))) {
    await failUnbegunConfiguredAIJob(payload, job.id, expectedToken, 'CONFIGURATION_SNAPSHOT_INVALID', clock().getTime())
    throw new Error('AI_JOB_UNAVAILABLE')
  }
  if (!await snapshotsStillCurrent(payload, snapshot)) {
    await failUnbegunConfiguredAIJob(payload, job.id, expectedToken, 'CONFIGURATION_SNAPSHOT_STALE', clock().getTime())
    throw new Error('AI_JOB_UNAVAILABLE')
  }
  // Refresh the lease before writing the irreversible dispatch intent. Two
  // bounded 15-second provider attempts remain within the 60-second lease.
  await renewConfiguredAIJob(payload, job.id, expectedToken, clock().getTime())
  await beginConfiguredAIJob(payload, job.id, expectedToken, clock().getTime())
  try {
    const result = await executeConfiguredAIJob(payload, { provider: job.provider, fallbackProvider: job.fallbackProvider, input: job.input, maxOutputTokens: job.maxOutputTokens }, {
      transport: options.transport,
      now: clock(),
      timeoutMs: Math.min(options.timeoutMs ?? 15_000, 15_000),
      configurationSnapshot: snapshot,
      executionKey: provider => configuredAIReservationKey(job.id, provider),
    })
    return await completeConfiguredAIJob(payload, job.id, expectedToken, { output: result.output, usageCostMicroUsd: result.usageCostMicroUsd, reservedMicroUsd: result.reservedMicroUsd, costStatus: result.usageCostStatus, usedProvider: result.provider, fallbackUsed: result.fallbackUsed }, clock().getTime())
  } catch (error) {
    await manualReviewConfiguredAIJob(payload, job.id, 'DISPATCH_OUTCOME_UNKNOWN', expectedToken)
    throw error instanceof Error && error.message === 'AI_JOB_UNAVAILABLE' ? error : new Error('AI_JOB_UNAVAILABLE')
  }
}

/** Convenience for a single in-process CMS worker; it does not create another database writer. */
export async function claimAndExecuteConfiguredAIJob(payload: Payload, options: ConfiguredAIExecutionOptions, actor = 'cms-ai-executor') {
  const now = (options.clock ?? (() => options.now ?? new Date()))()
  const claimed = await claimConfiguredAIJob(payload, actor, now.getTime())
  return claimed ? executeClaimedConfiguredAIJob(payload, claimed as ClaimedConfiguredAIJob, options) : undefined
}
