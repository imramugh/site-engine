import { open, unlink, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Payload, PayloadRequest } from 'payload'
import { applicationStorage } from './applications'
import { assetUsage } from './media'
import { withPayloadTransaction } from './auth-transaction'

export const RETENTION_DAYS = 30
export type RetentionKind = 'spam-inquiry' | 'application' | 'media'
export type RetentionPolicy = { spamDays: number; mediaBinDays: number; retainedInquiries: 'manual'; applicationsAndResumes: 'manual' }
export const defaultRetentionPolicy: RetentionPolicy = { spamDays: RETENTION_DAYS, mediaBinDays: RETENTION_DAYS, retainedInquiries: 'manual', applicationsAndResumes: 'manual' }
const day = 86_400_000

export function retentionEligible(at: string | null | undefined, now: Date, days = RETENTION_DAYS): boolean {
  const then = at ? Date.parse(at) : Number.NaN
  return Number.isFinite(then) && then <= now.getTime() - days * day
}

export async function retentionPolicy(payload: Payload, req?: PayloadRequest): Promise<RetentionPolicy> {
  const settings = await payload.find({ collection: 'retention-settings', limit: 1, depth: 0, overrideAccess: true, req })
  const row = settings.docs[0] as { spamDays?: number; mediaBinDays?: number } | undefined
  return { ...defaultRetentionPolicy, ...(row ? { spamDays: row.spamDays ?? RETENTION_DAYS, mediaBinDays: row.mediaBinDays ?? RETENTION_DAYS } : {}) }
}

async function job(payload: Payload, req: PayloadRequest | undefined, kind: RetentionKind, resourceID: string, data: Record<string, unknown> = {}) {
  const found = await payload.find({ collection: 'retention-purge-jobs', where: { and: [{ resourceType: { equals: kind } }, { resourceID: { equals: resourceID } }, { state: { not_equals: 'completed' } }] }, limit: 1, depth: 0, overrideAccess: true, req })
  if (found.docs[0]) return found.docs[0] as { id: string }
  return payload.create({ collection: 'retention-purge-jobs', data: { resourceType: kind, resourceID, state: 'queued', attempts: 0, ...data }, overrideAccess: true, req }) as Promise<{ id: string }>
}

async function completeJob(payload: Payload, req: PayloadRequest | undefined, id: string) {
  await payload.update({ collection: 'retention-purge-jobs', id, data: { state: 'completed', completedAt: new Date().toISOString(), lastError: null, resumeKey: null }, overrideAccess: true, req })
}
async function failJob(payload: Payload, req: PayloadRequest | undefined, id: string, attempts: number, error: unknown) {
  await payload.update({ collection: 'retention-purge-jobs', id, data: { state: 'failed', attempts: attempts + 1, lastError: error instanceof Error ? error.message.slice(0, 500) : 'Storage purge failed.' }, overrideAccess: true, req })
}

/** Only identity and time survive a purge. It intentionally has no content, file key, email, or actor name. */
export async function writeDeletionTombstone(payload: Payload, req: PayloadRequest | undefined, resourceType: 'application' | 'inquiry' | 'media', resourceID: string) {
  const existing = await payload.find({ collection: 'deletion-tombstones', where: { and: [{ resourceType: { equals: resourceType } }, { resourceID: { equals: resourceID } }] }, limit: 1, depth: 0, overrideAccess: true, req })
  if (!existing.docs[0]) await payload.create({ collection: 'deletion-tombstones', data: { resourceType, resourceID, deletedAt: new Date().toISOString() }, overrideAccess: true, req })
}

async function appendExternalTombstone(resourceType: 'application' | 'inquiry' | 'media', resourceID: string, deletedAt = new Date().toISOString()) {
  const file = process.env.RETENTION_TOMBSTONES_FILE
  if (!file || !file.startsWith('/')) throw new Error('Retention deletion ledger is not configured.')
  const metadata = await stat(file)
  if (!metadata.isFile() || (metadata.mode & 0o077)) throw new Error('Retention deletion ledger must be a restricted regular file.')
  const handle = await open(file, 'a')
  try { await handle.write(`${JSON.stringify({ resourceType, resourceID, deletedAt })}\n`); await handle.sync() } finally { await handle.close() }
  const directory = await open(resolve(file, '..'), 'r'); try { await directory.sync() } finally { await directory.close() }
}

async function unlinkResume(key: string) {
  if (!/^[0-9a-f-]{36}-[a-f0-9]{64}$/i.test(key)) throw new Error('Invalid stored resume key.')
  try { await unlink(resolve(applicationStorage(), key)) } catch (error: unknown) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
}

export async function purgeApplication(payload: Payload, id: string, actor: string | undefined, req?: PayloadRequest): Promise<{ state: 'completed' | 'failed'; jobID: string }> {
  const application = await payload.findByID({ collection: 'applications', id, depth: 0, overrideAccess: true, req }) as { resumeKey: string }
  const record = await job(payload, req, 'application', id, { resumeKey: application.resumeKey }) as { id: string; attempts?: number }
  try {
    await appendExternalTombstone('application', id)
    // Storage goes first. A database record remains readable while its private object cannot be purged.
    await unlinkResume(application.resumeKey)
    await withPayloadTransaction(payload, async (transaction) => {
      await writeDeletionTombstone(payload, transaction, 'application', id)
      await payload.delete({ collection: 'applications', id, overrideAccess: true, req: transaction, context: { retentionPurge: true } })
      await payload.create({ collection: 'audit-events', data: { event: 'retention.application_purged', user: actor, actor, detail: { application: id } }, overrideAccess: true, req: transaction })
    })
    await completeJob(payload, req, record.id)
    return { state: 'completed', jobID: record.id }
  } catch (error) { await failJob(payload, req, record.id, record.attempts ?? 0, error); return { state: 'failed', jobID: record.id } }
}

async function purgeMedia(payload: Payload, req: PayloadRequest | undefined, id: string, attempts = 0): Promise<'completed' | 'failed' | 'skipped'> {
  const record = await job(payload, req, 'media', id) as { id: string }
  try {
    const usages = await assetUsage(payload, req as PayloadRequest, id)
    if (usages.length) return 'skipped'
    await appendExternalTombstone('media', id)
    await payload.delete({ collection: 'assets', id, overrideAccess: true, req, context: { retentionPurge: true } })
    await completeJob(payload, req, record.id)
    return 'completed'
  } catch (error) { await failJob(payload, req, record.id, attempts, error); return 'failed' }
}

/** Worker entrypoint. Call on a schedule; it never runs from an admin read request. */
export async function runRetentionCleanup(payload: Payload, now = new Date()): Promise<{ spam: number; media: number; failed: number }> {
  const policy = await retentionPolicy(payload)
  let spam = 0; let media = 0; let failed = 0
  const spamLeads = await payload.find({ collection: 'inquiries', where: { and: [{ spam: { equals: true } }, { spamMarkedAt: { less_than_equal: new Date(now.getTime() - policy.spamDays * day).toISOString() } }] }, limit: 200, pagination: false, depth: 0, overrideAccess: true })
  for (const lead of spamLeads.docs) {
    try {
      await withPayloadTransaction(payload, async (req) => {
        await appendExternalTombstone('inquiry', String(lead.id))
        await writeDeletionTombstone(payload, req, 'inquiry', String(lead.id))
        req.context.leadSpamDeleteLifecycle = true
        await payload.delete({ collection: 'inquiries', id: lead.id, overrideAccess: true, req })
        await payload.create({ collection: 'audit-events', data: { event: 'retention.spam_purged', detail: { inquiry: lead.id } }, overrideAccess: true, req })
      }); spam += 1
    } catch { failed += 1 }
  }
  const binned = await payload.find({ collection: 'assets', where: { and: [{ deletedAt: { exists: true } }, { deleteAfter: { less_than_equal: now.toISOString() } }] }, limit: 200, pagination: false, depth: 0, overrideAccess: true })
  for (const asset of binned.docs) { const outcome = await purgeMedia(payload, undefined, String(asset.id)); if (outcome === 'completed') media += 1; if (outcome === 'failed') failed += 1 }
  const retry = await payload.find({ collection: 'retention-purge-jobs', where: { state: { equals: 'failed' } }, limit: 100, pagination: false, depth: 0, overrideAccess: true })
  for (const item of retry.docs as Array<{ id: string; resourceType: RetentionKind; resourceID: string; attempts?: number }>) {
    if (item.resourceType === 'media') { const outcome = await purgeMedia(payload, undefined, item.resourceID, item.attempts ?? 0); if (outcome === 'failed') failed += 1 }
    if (item.resourceType === 'application') { const outcome = await purgeApplication(payload, item.resourceID, undefined); if (outcome.state === 'failed') failed += 1 }
  }
  return { spam, media, failed }
}

/** Run after restoring a backup and before serving it. Tombstones are replayed without exposing restored records. */
export async function reapplyDeletionTombstones(payload: Payload): Promise<number> {
  const tombstones = await payload.find({ collection: 'deletion-tombstones', limit: 0, pagination: false, depth: 0, overrideAccess: true })
  let applied = 0
  for (const marker of tombstones.docs as Array<{ resourceType: 'application' | 'inquiry' | 'media'; resourceID: string }>) {
    try {
      if (marker.resourceType === 'application') { await purgeApplication(payload, marker.resourceID, undefined); applied += 1 }
      else if (marker.resourceType === 'inquiry') { await withPayloadTransaction(payload, async (req) => { req.context.leadSpamDeleteLifecycle = true; await payload.delete({ collection: 'inquiries', id: marker.resourceID, overrideAccess: true, req }); applied += 1 }) }
      else { await payload.delete({ collection: 'assets', id: marker.resourceID, overrideAccess: true, context: { retentionPurge: true } }); applied += 1 }
    } catch (error: unknown) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error }
  }
  return applied
}
