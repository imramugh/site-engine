import { randomUUID, createHash } from 'node:crypto'
import type { Payload, PayloadRequest } from 'payload'
import { withPayloadTransaction } from './auth-transaction'
import type { IntegrationProvider } from './integrations'

const leaseMs = 60_000
const retries = 8
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value)
const proof = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
type Job = { id: string; state: string; leaseToken?: string | null; leaseExpiresAt?: string | null; dispatchStartedAt?: string | null; resultDigest?: string | null }
export type ConfiguredAICompletion = { output: string; usageCostMicroUsd: number | null; reservedMicroUsd: number; costStatus: 'actual' | 'reserved'; usedProvider?: IntegrationProvider; fallbackUsed?: boolean }
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
  if (!Object.keys(candidate).every(key => ['output', 'usageCostMicroUsd', 'reservedMicroUsd', 'costStatus', 'usedProvider', 'fallbackUsed'].includes(key)) || !['output', 'usageCostMicroUsd', 'reservedMicroUsd', 'costStatus'].every(key => Object.hasOwn(candidate, key)) || typeof output !== 'string' || output.length > 100_000 || !Number.isSafeInteger(reservedMicroUsd) || reservedMicroUsd === undefined || reservedMicroUsd < 0 || (usageCostMicroUsd !== null && (!Number.isSafeInteger(usageCostMicroUsd) || usageCostMicroUsd === undefined || usageCostMicroUsd < 0)) || (costStatus !== 'actual' && costStatus !== 'reserved') || (costStatus === 'actual' && usageCostMicroUsd === null) || (costStatus === 'reserved' && usageCostMicroUsd !== null) || (candidate.usedProvider !== undefined && !['openai', 'anthropic', 'google-gemini', 'openrouter'].includes(candidate.usedProvider)) || (candidate.fallbackUsed !== undefined && typeof candidate.fallbackUsed !== 'boolean')) throw new Error('COMPLETION_INVALID')
}

const leaseRecovery = new WeakMap<object, Promise<void>>()

async function scanInvalidLeaseTimestamps(payload: Payload) {
  const client = (payload.db as unknown as { client: { execute: (query: { sql: string; args: unknown[] }) => Promise<{ rows: Array<{ id: string; lease_expires_at?: string | null }>; rowsAffected?: number }> } }).client
  let page = 1; const invalid: Array<{ id: string; lease: string | null }> = []
  while (true) {
    const running = await client.execute({ sql: 'SELECT id, lease_expires_at FROM configured_ai_jobs WHERE state = ? ORDER BY created_at LIMIT ? OFFSET ?', args: ['running', 100, (page - 1) * 100] })
    for (const raw of running.rows) if (!raw.lease_expires_at || !Number.isFinite(Date.parse(raw.lease_expires_at))) invalid.push({ id: raw.id, lease: raw.lease_expires_at ?? null })
    if (running.rows.length < 100 || page >= 100_000) break
    page += 1
  }
  for (const item of invalid) {
    const updated = await client.execute({ sql: 'UPDATE configured_ai_jobs SET state = ?, failure_code = ?, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND state = ? AND lease_expires_at IS ?', args: ['manual-review', 'LEASE_INVALID_TIMESTAMP', item.id, 'running', item.lease] })
    if ((updated.rowsAffected ?? 0) > 0) await payload.create({ collection: 'audit-events', data: { event: 'ai.job_manual_review', detail: { job: item.id, reason: 'LEASE_INVALID_TIMESTAMP' } }, overrideAccess: true })
  }
}

async function recoverInvalidLeaseTimestamps(payload: Payload) {
  const previous = leaseRecovery.get(payload) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => scanInvalidLeaseTimestamps(payload))
  leaseRecovery.set(payload, next)
  try { await next } finally { if (leaseRecovery.get(payload) === next) leaseRecovery.delete(payload) }
}

const claimSerial = new WeakMap<object, Promise<unknown>>()

export async function claimConfiguredAIJob(payload: Payload, actor = 'worker', now = Date.now()) {
  const previous = claimSerial.get(payload) ?? Promise.resolve()
  const claim = previous.catch(() => undefined).then(async () => {
    await recoverInvalidLeaseTimestamps(payload)
    return transition(payload, async req => {
    // SQLite's lexical date comparison excludes malformed timestamps forever.
    // Scan the bounded pages explicitly so a corrupt running lease is surfaced
    // for review instead of becoming an unrecoverable queue head.
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
  })
  claimSerial.set(payload, claim)
  try { return await claim } finally { if (claimSerial.get(payload) === claim) claimSerial.delete(payload) }
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
    const completed = await payload.update({ collection: 'configured-ai-jobs', id, data: { state: 'completed', result: canonical(result), resultDigest, costStatus: result.costStatus, usedProvider: result.usedProvider ?? null, fallbackUsed: result.fallbackUsed ?? false }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'ai.job_completed', detail: { job: id, resultDigest, costStatus: result.costStatus } }, overrideAccess: true, req })
    return completed
  })
}

/** A begun job may have reached a provider. It is never returned to the queue. */
export async function manualReviewConfiguredAIJob(payload: Payload, id: string, reason: string, expectedToken?: string) {
  return transition(payload, async req => {
    const job = await leaseJob(payload, id, req)
    if (expectedToken !== undefined && (job.state !== 'running' || job.leaseToken !== expectedToken || !job.dispatchStartedAt)) throw new Error('LEASE_INVALID')
    if (job.state === 'completed') return job
    const updated = await payload.update({ collection: 'configured-ai-jobs', id, data: { state: 'manual-review', failureCode: reason, leaseToken: null, leaseExpiresAt: null }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'ai.job_manual_review', detail: { job: id, reason } }, overrideAccess: true, req })
    return updated
  })
}

/** A pre-dispatch validation failure is safe to close because no provider request was sent. */
export async function failUnbegunConfiguredAIJob(payload: Payload, id: string, token: string, reason: string, now = Date.now()) {
  return transition(payload, async req => {
    const job = await leaseJob(payload, id, req)
    if (job.state !== 'running' || job.leaseToken !== token || expired(job, now) || job.dispatchStartedAt) throw new Error('LEASE_INVALID')
    const updated = await payload.update({ collection: 'configured-ai-jobs', id, data: { state: 'failed', failureCode: reason, leaseToken: null, leaseExpiresAt: null }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'ai.job_failed', detail: { job: id, reason } }, overrideAccess: true, req })
    return updated
  })
}
