import { randomUUID, createHash } from 'node:crypto'
import type { Payload, PayloadRequest } from 'payload'
import { withPayloadTransaction } from './auth-transaction'

const leaseMs = 60_000
const retries = 8
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value)
const proof = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
type Job = { id: string; state: string; leaseToken?: string | null; leaseExpiresAt?: string | null; dispatchStartedAt?: string | null; resultDigest?: string | null }
export type ConfiguredAICompletion = { output: string; usageCostMicroUsd: number | null; reservedMicroUsd: number; costStatus: 'actual' | 'reserved' }
const expired = (job: Job, now: number) => {
  const leaseUntil = job.leaseExpiresAt ? Date.parse(job.leaseExpiresAt) : Number.NaN
  return !Number.isFinite(leaseUntil) || leaseUntil <= now
}
const busy = (error: unknown) => (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'SQLITE_BUSY') || error instanceof Error && error.message.includes('SQLITE_BUSY')
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
async function leaseJob(payload: Payload, id: string, req: PayloadRequest) {
  try { return await payload.findByID({ collection: 'configured-ai-jobs', id, depth: 0, overrideAccess: true, req }) as unknown as Job }
  catch (error) { if (error instanceof Error && error.message.includes('Invalid time value')) throw new Error('LEASE_INVALID'); throw error }
}

async function transition<T>(payload: Payload, operation: Parameters<typeof withPayloadTransaction<T>>[1]) {
  for (let attempt = 0; attempt < retries; attempt += 1) try {
    return await withPayloadTransaction(payload, operation)
  } catch (error) {
    if (!busy(error) || attempt === retries - 1) throw error
    await pause(25 * (attempt + 1))
  }
  throw new Error('AI_JOB_TRANSITION_UNAVAILABLE')
}

function completion(value: unknown): asserts value is ConfiguredAICompletion {
  if (!value || typeof value !== 'object') throw new Error('COMPLETION_INVALID')
  const candidate = value as Partial<ConfiguredAICompletion>
  const { output, usageCostMicroUsd, reservedMicroUsd, costStatus } = candidate
  if (Object.keys(candidate).length !== 4 || !['output', 'usageCostMicroUsd', 'reservedMicroUsd', 'costStatus'].every(key => Object.hasOwn(candidate, key)) || typeof output !== 'string' || output.length > 100_000 || !Number.isSafeInteger(reservedMicroUsd) || reservedMicroUsd === undefined || reservedMicroUsd < 0 || (usageCostMicroUsd !== null && (!Number.isSafeInteger(usageCostMicroUsd) || usageCostMicroUsd === undefined || usageCostMicroUsd < 0)) || (costStatus !== 'actual' && costStatus !== 'reserved') || (costStatus === 'actual' && usageCostMicroUsd === null) || (costStatus === 'reserved' && usageCostMicroUsd !== null)) throw new Error('COMPLETION_INVALID')
}

export async function claimConfiguredAIJob(payload: Payload, actor = 'worker', now = Date.now()) {
  return transition(payload, async req => {
    const rows = await payload.find({ collection: 'configured-ai-jobs', where: { or: [{ state: { equals: 'queued' } }, { and: [{ state: { equals: 'running' } }, { leaseExpiresAt: { less_than_equal: new Date(now).toISOString() } }] }] }, sort: 'createdAt', limit: 100, depth: 0, overrideAccess: true, req })
    for (const raw of rows.docs as unknown as Job[]) {
      if (raw.dispatchStartedAt) {
        const reason = raw.state === 'queued' ? 'DISPATCH_WITHOUT_LEASE' : 'LEASE_EXPIRED_AFTER_DISPATCH'
        await payload.update({ collection: 'configured-ai-jobs', id: raw.id, data: { state: 'manual-review', failureCode: reason }, overrideAccess: true, req })
        await payload.create({ collection: 'audit-events', data: { event: 'ai.job_manual_review', detail: { job: raw.id, reason } }, overrideAccess: true, req })
        continue
      }
      const token = randomUUID(); const leaseExpiresAt = new Date(now + leaseMs).toISOString()
      const job = await payload.update({ collection: 'configured-ai-jobs', id: raw.id, data: { state: 'running', leaseToken: token, leaseExpiresAt }, overrideAccess: true, req })
      await payload.create({ collection: 'audit-events', data: { event: 'ai.job_claimed', detail: { job: raw.id, actor } }, overrideAccess: true, req })
      return { job, leaseToken: token, leaseExpiresAt }
    }
    return undefined
  })
}

export async function renewConfiguredAIJob(payload: Payload, id: string, token: string, now = Date.now()) {
  return transition(payload, async req => {
    const job = await leaseJob(payload, id, req)
    if (job.state !== 'running' || job.leaseToken !== token || expired(job, now)) throw new Error('LEASE_INVALID')
    return payload.update({ collection: 'configured-ai-jobs', id, data: { leaseExpiresAt: new Date(now + leaseMs).toISOString() }, overrideAccess: true, req })
  })
}

export async function beginConfiguredAIJob(payload: Payload, id: string, token: string, now = Date.now()) {
  return transition(payload, async req => {
    const job = await leaseJob(payload, id, req)
    if (job.state !== 'running' || job.leaseToken !== token || expired(job, now)) throw new Error('LEASE_INVALID')
    if (job.dispatchStartedAt) throw new Error('ALREADY_DISPATCHED')
    return payload.update({ collection: 'configured-ai-jobs', id, data: { dispatchStartedAt: new Date(now).toISOString() }, overrideAccess: true, req })
  })
}

export async function completeConfiguredAIJob(payload: Payload, id: string, token: string, result: ConfiguredAICompletion, now = Date.now()) {
  completion(result)
  const resultDigest = proof(result)
  return transition(payload, async req => {
    const job = await leaseJob(payload, id, req)
    if (job.leaseToken !== token) throw new Error('LEASE_INVALID')
    if (job.state === 'completed') {
      if (job.resultDigest === resultDigest) return job
      throw new Error('COMPLETION_CONFLICT')
    }
    if (expired(job, now)) throw new Error('LEASE_INVALID')
    if (!job.dispatchStartedAt) throw new Error('DISPATCH_NOT_BEGUN')
    if (job.state !== 'running' || expired(job, now)) throw new Error('LEASE_INVALID')
    const completed = await payload.update({ collection: 'configured-ai-jobs', id, data: { state: 'completed', result: canonical(result), resultDigest, costStatus: result.costStatus }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'ai.job_completed', detail: { job: id, resultDigest, costStatus: result.costStatus } }, overrideAccess: true, req })
    return completed
  })
}
