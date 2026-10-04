import { randomUUID, createHash } from 'node:crypto'
import type { Payload } from 'payload'
import { withPayloadTransaction } from './auth-transaction'

const leaseMs = 60_000
const proof = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Job = { id: string; state: string; leaseToken?: string | null; leaseExpiresAt?: string | null; dispatchStartedAt?: string | null; resultDigest?: string | null; result?: unknown }
const expired = (job: Job, now: number) => !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= now

export async function claimConfiguredAIJob(payload: Payload, actor = 'worker', now = Date.now()) {
  return withPayloadTransaction(payload, async req => {
    const rows = await payload.find({ collection: 'configured-ai-jobs', where: { state: { in: ['queued', 'running'] } }, sort: 'createdAt', limit: 100, depth: 0, overrideAccess: true, req })
    for (const raw of rows.docs as unknown as Job[]) {
      if (raw.state === 'running' && !expired(raw, now)) continue
      if (raw.state === 'running' && raw.dispatchStartedAt) { await payload.update({ collection: 'configured-ai-jobs', id: raw.id, data: { state: 'manual-review', failureCode: 'LEASE_EXPIRED_AFTER_DISPATCH' }, overrideAccess: true, req }); continue }
      const token = randomUUID(); const leaseExpiresAt = new Date(now + leaseMs).toISOString()
      const job = await payload.update({ collection: 'configured-ai-jobs', id: raw.id, data: { state: 'running', leaseToken: token, leaseExpiresAt }, overrideAccess: true, req })
      await payload.create({ collection: 'audit-events', data: { event: 'ai.job_claimed', detail: { job: raw.id } }, overrideAccess: true, req })
      return { job, leaseToken: token, leaseExpiresAt }
    }
    return undefined
  })
}
export async function renewConfiguredAIJob(payload: Payload, id: string, token: string, now = Date.now()) { const job = await payload.findByID({ collection: 'configured-ai-jobs', id, depth: 0, overrideAccess: true }) as unknown as Job; if (job.state !== 'running' || job.leaseToken !== token || expired(job, now)) throw new Error('LEASE_INVALID'); return payload.update({ collection: 'configured-ai-jobs', id, data: { leaseExpiresAt: new Date(now + leaseMs).toISOString() }, overrideAccess: true }) }
export async function beginConfiguredAIJob(payload: Payload, id: string, token: string, now = Date.now()) { const job = await payload.findByID({ collection: 'configured-ai-jobs', id, depth: 0, overrideAccess: true }) as unknown as Job; if (job.state !== 'running' || job.leaseToken !== token || expired(job, now)) throw new Error('LEASE_INVALID'); if (job.dispatchStartedAt) return job; return payload.update({ collection: 'configured-ai-jobs', id, data: { dispatchStartedAt: new Date(now).toISOString() }, overrideAccess: true }) }
export async function completeConfiguredAIJob(payload: Payload, id: string, token: string, result: unknown, now = Date.now()) { const job = await payload.findByID({ collection: 'configured-ai-jobs', id, depth: 0, overrideAccess: true }) as unknown as Job; const digest = proof(result); if (job.state === 'completed') { if (job.resultDigest === digest) return job; throw new Error('COMPLETION_CONFLICT') } if (job.state !== 'running' || job.leaseToken !== token || expired(job, now)) throw new Error('LEASE_INVALID'); return payload.update({ collection: 'configured-ai-jobs', id, data: { state: 'completed', result: JSON.stringify(result), resultDigest: digest, costStatus: 'reserved' }, overrideAccess: true }) }
