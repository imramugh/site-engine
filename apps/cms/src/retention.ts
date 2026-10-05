import { constants } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Payload, PayloadRequest } from 'payload'
import { applicationStorage } from './applications'
import { assetVersionIDsForRetention, retentionMediaReferences } from './retention-media'
import { withPayloadTransaction } from './auth-transaction'

export const RETENTION_DAYS = 30
export type RetentionKind = 'spam-inquiry' | 'application' | 'media'
export type RetentionPolicy = { spamDays: number; mediaBinDays: number; retainedInquiries: 'manual'; applicationsAndResumes: 'manual' }
export const defaultRetentionPolicy: RetentionPolicy = { spamDays: RETENTION_DAYS, mediaBinDays: RETENTION_DAYS, retainedInquiries: 'manual', applicationsAndResumes: 'manual' }
const day = 86_400_000
const applicationPurgeLocks = new Map<string, Promise<{ state: 'completed' | 'failed'; jobID: string }>>()

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
  const found = await payload.find({ collection: 'retention-purge-jobs', where: { and: [{ resourceType: { equals: kind } }, { resourceID: { equals: resourceID } }] }, limit: 1, depth: 0, overrideAccess: true, req })
  if (found.docs[0]) return found.docs[0] as { id: string }
  try {
    return await payload.create({ collection: 'retention-purge-jobs', data: { resourceType: kind, resourceID, state: 'queued', attempts: 0, ...data }, overrideAccess: true, req }) as { id: string }
  } catch {
    const concurrent = await payload.find({ collection: 'retention-purge-jobs', where: { and: [{ resourceType: { equals: kind } }, { resourceID: { equals: resourceID } }] }, limit: 1, depth: 0, overrideAccess: true, req })
    if (concurrent.docs[0]) return concurrent.docs[0] as { id: string }
    throw new Error('Could not claim retention purge job.')
  }
}

function isNotFound(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'status' in error && error.status === 404) }
async function hasTombstone(payload: Payload, req: PayloadRequest | undefined, type: 'application' | 'inquiry' | 'media', id: string) {
  const found = await payload.find({ collection: 'deletion-tombstones', where: { and: [{ resourceType: { equals: type } }, { resourceID: { equals: id } }] }, limit: 1, depth: 0, overrideAccess: true, req })
  return Boolean(found.docs[0])
}

async function completeJob(payload: Payload, req: PayloadRequest | undefined, id: string) {
  await payload.update({ collection: 'retention-purge-jobs', id, data: { state: 'completed', completedAt: new Date().toISOString(), lastError: null, resumeKey: null }, overrideAccess: true, req })
}
async function failJob(payload: Payload, req: PayloadRequest | undefined, id: string, attempts: number, error: unknown) {
  const code = error instanceof Error && /ledger/i.test(error.message) ? 'deletion-ledger-unavailable' : 'storage-purge-failed'
  await payload.update({ collection: 'retention-purge-jobs', id, data: { state: 'failed', attempts: attempts + 1, lastError: code }, overrideAccess: true, req })
}

/** Only identity and time survive a purge. It intentionally has no content, file key, email, or actor name. */
export async function writeDeletionTombstone(payload: Payload, req: PayloadRequest | undefined, resourceType: 'application' | 'inquiry' | 'media', resourceID: string) {
  const existing = await payload.find({ collection: 'deletion-tombstones', where: { and: [{ resourceType: { equals: resourceType } }, { resourceID: { equals: resourceID } }] }, limit: 1, depth: 0, overrideAccess: true, req })
  if (!existing.docs[0]) await payload.create({ collection: 'deletion-tombstones', data: { resourceType, resourceID, deletedAt: new Date().toISOString() }, overrideAccess: true, req })
}

export async function recordDeletionIntent(payload: Payload, req: PayloadRequest | undefined, resourceType: 'application' | 'inquiry' | 'media', resourceID: string, deletedAt = new Date().toISOString()) {
  const file = process.env.RETENTION_TOMBSTONES_FILE
  if (!file || !file.startsWith('/')) throw new Error('Retention deletion ledger is not configured.')
  const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
  try { const metadata = await handle.stat(); if (!metadata.isFile() || (metadata.mode & 0o077)) throw new Error('Retention deletion ledger must be a restricted regular file.'); await handle.writeFile(`${JSON.stringify({ resourceType, resourceID, deletedAt })}\n`); await handle.sync() } finally { await handle.close() }
  const directory = await open(resolve(file, '..'), 'r'); try { await directory.sync() } finally { await directory.close() }
  await writeDeletionTombstone(payload, req, resourceType, resourceID)
}

async function unlinkResume(key: string) {
  if (!/^[0-9a-f-]{36}-[a-f0-9]{64}$/i.test(key)) throw new Error('Invalid stored resume key.')
  try { await unlink(resolve(applicationStorage(), key)) } catch (error: unknown) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
}

async function purgeApplicationUnlocked(payload: Payload, id: string, actor: string | undefined, req?: PayloadRequest): Promise<{ state: 'completed' | 'failed'; jobID: string }> {
  const record = await job(payload, req, 'application', id) as { id: string; attempts?: number; state?: string }
  // Even a completed job must recheck the record: an older restored snapshot
  // can contain data that the independent deletion ledger says to remove.
  try {
    const application = await payload.findByID({ collection: 'applications', id, depth: 0, overrideAccess: true, req }) as { resumeKey: string }
    await recordDeletionIntent(payload, req, 'application', id)
    // Storage goes first. A database record remains readable while its private object cannot be purged.
    await unlinkResume(application.resumeKey)
    await withPayloadTransaction(payload, async (transaction) => {
      await writeDeletionTombstone(payload, transaction, 'application', id)
      await payload.delete({ collection: 'applications', id, overrideAccess: true, req: transaction, context: { retentionPurge: true } })
      await payload.create({ collection: 'audit-events', data: { event: 'retention.application_purged', user: actor, actor, detail: { application: id } }, overrideAccess: true, req: transaction })
    })
    await completeJob(payload, req, record.id)
    return { state: 'completed', jobID: record.id }
  } catch (error) {
    if (isNotFound(error) && await hasTombstone(payload, req, 'application', id)) { await completeJob(payload, req, record.id); return { state: 'completed', jobID: record.id } }
    await failJob(payload, req, record.id, record.attempts ?? 0, error); return { state: 'failed', jobID: record.id }
  }
}

/** Coalesce same-process cleanup/API races; the unique job key covers separate workers. */
export async function purgeApplication(payload: Payload, id: string, actor: string | undefined, req?: PayloadRequest): Promise<{ state: 'completed' | 'failed'; jobID: string }> {
  const active = applicationPurgeLocks.get(id)
  if (active) return active
  const running = purgeApplicationUnlocked(payload, id, actor, req)
  applicationPurgeLocks.set(id, running)
  try { return await running } finally { if (applicationPurgeLocks.get(id) === running) applicationPurgeLocks.delete(id) }
}

/** Owner-requested retained-inquiry deletion. Spam cleanup uses its separate automatic lifecycle. */
export async function purgeRetainedInquiry(payload: Payload, id: string, actor: string | undefined): Promise<void> {
  await withPayloadTransaction(payload, async (req) => {
    const current = await payload.findByID({ collection: 'inquiries', id, depth: 0, overrideAccess: true, req }) as { spam?: boolean }
    if (current.spam) throw new Error('Spam inquiries use the spam deletion lifecycle.')
    await recordDeletionIntent(payload, req, 'inquiry', id)
    const drafts = await payload.find({ collection: 'mail-drafts', where: { lead: { equals: id } }, limit: 0, pagination: false, depth: 0, overrideAccess: true, req })
    for (const draft of drafts.docs) {
      const grants = await payload.find({ collection: 'mail-authorizations', where: { draft: { equals: draft.id } }, limit: 0, pagination: false, depth: 0, overrideAccess: true, req })
      for (const grant of grants.docs) await payload.delete({ collection: 'mail-authorizations', id: grant.id, overrideAccess: true, req })
      await payload.delete({ collection: 'mail-drafts', id: draft.id, overrideAccess: true, req })
    }
    req.context.retentionPurge = true
    await payload.delete({ collection: 'inquiries', id, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'retention.inquiry_purged', user: actor, actor, detail: { inquiry: id } }, overrideAccess: true, req })
  })
}

async function purgeMedia(payload: Payload, req: PayloadRequest | undefined, id: string, attempts = 0): Promise<'completed' | 'failed' | 'skipped'> {
  const record = await job(payload, req, 'media', id) as { id: string; state?: string }
  try {
    const references = await retentionMediaReferences(payload, req, id)
    if (references.length) return 'skipped'
    const versionIDs = await assetVersionIDsForRetention(payload, req, id)
    await recordDeletionIntent(payload, req, 'media', id)
    // Keep the parent relationship until every immutable file version is gone.
    // If storage fails midway, the next attempt can still discover remaining bytes.
    for (const versionID of versionIDs) await payload.delete({ collection: 'asset-file-versions', id: versionID, overrideAccess: true, req, context: { retentionMediaGC: true } })
    await payload.delete({ collection: 'assets', id, overrideAccess: true, req, context: { retentionPurge: true } })
    await completeJob(payload, req, record.id)
    return 'completed'
  } catch (error) {
    if (isNotFound(error) && await hasTombstone(payload, req, 'media', id)) { await completeJob(payload, req, record.id); return 'completed' }
    await failJob(payload, req, record.id, attempts, error); return 'failed'
  }
}

async function purgeSpamInquiry(payload: Payload, id: string, cutoff: string): Promise<'completed' | 'failed' | 'skipped'> {
  const record = await job(payload, undefined, 'spam-inquiry', id) as { id: string; attempts?: number }
  try {
    return await withPayloadTransaction(payload, async (req) => {
      const lead = await payload.findByID({ collection: 'inquiries', id, depth: 0, overrideAccess: true, req })
      // Recheck after claiming the job: an Owner may have restored this lead.
      if (!lead.spam || !lead.spamMarkedAt || lead.spamMarkedAt > cutoff) return 'skipped' as const
      await recordDeletionIntent(payload, req, 'inquiry', id)
      req.context.leadSpamDeleteLifecycle = true
      await payload.delete({ collection: 'inquiries', id, overrideAccess: true, req })
      await payload.create({ collection: 'audit-events', data: { event: 'retention.spam_purged', detail: { inquiry: id } }, overrideAccess: true, req })
      await completeJob(payload, req, record.id)
      return 'completed' as const
    })
  } catch (error) {
    if (isNotFound(error) && await hasTombstone(payload, undefined, 'inquiry', id)) { await completeJob(payload, undefined, record.id); return 'completed' }
    await failJob(payload, undefined, record.id, record.attempts ?? 0, error)
    return 'failed'
  }
}

/** Worker entrypoint. Call on a schedule; it never runs from an admin read request. */
export async function runRetentionCleanup(payload: Payload, now = new Date()): Promise<{ spam: number; media: number; failed: number }> {
  const policy = await retentionPolicy(payload)
  let spam = 0; let media = 0; let failed = 0
  const spamCutoff = new Date(now.getTime() - policy.spamDays * day).toISOString()
  const spamLeads = await payload.find({ collection: 'inquiries', where: { and: [{ spam: { equals: true } }, { spamMarkedAt: { less_than_equal: spamCutoff } }] }, sort: 'spamMarkedAt', limit: 200, pagination: false, depth: 0, overrideAccess: true })
  for (const lead of spamLeads.docs) {
    const outcome = await purgeSpamInquiry(payload, String(lead.id), spamCutoff)
    if (outcome === 'completed') spam += 1
    if (outcome === 'failed') failed += 1
  }
  const binned = await payload.find({ collection: 'assets', where: { deletedAt: { less_than_equal: new Date(now.getTime() - policy.mediaBinDays * day).toISOString() } }, sort: 'deletedAt', limit: 200, pagination: false, depth: 0, overrideAccess: true })
  for (const asset of binned.docs) if (retentionEligible(asset.deletedAt as string | null | undefined, now, policy.mediaBinDays)) { const outcome = await purgeMedia(payload, undefined, String(asset.id)); if (outcome === 'completed') media += 1; if (outcome === 'failed') failed += 1 }
  const retry = await payload.find({ collection: 'retention-purge-jobs', where: { state: { equals: 'failed' } }, limit: 100, pagination: false, depth: 0, overrideAccess: true })
  for (const item of retry.docs as Array<{ id: string; resourceType: RetentionKind; resourceID: string; attempts?: number }>) {
    if (item.resourceType === 'spam-inquiry') { const outcome = await purgeSpamInquiry(payload, item.resourceID, spamCutoff); if (outcome === 'failed') failed += 1 }
    if (item.resourceType === 'media') { const outcome = await purgeMedia(payload, undefined, item.resourceID, item.attempts ?? 0); if (outcome === 'failed') failed += 1 }
    if (item.resourceType === 'application') { try { const outcome = await purgeApplication(payload, item.resourceID, undefined); if (outcome.state === 'failed') failed += 1 } catch { failed += 1 } }
  }
  return { spam, media, failed }
}

/** Run after restoring a backup and before serving it. Tombstones are replayed without exposing restored records. */
export async function reapplyDeletionTombstones(payload: Payload): Promise<number> {
  const tombstones = await payload.find({ collection: 'deletion-tombstones', limit: 0, pagination: false, depth: 0, overrideAccess: true })
  let applied = 0
  for (const marker of tombstones.docs as Array<{ resourceType: 'application' | 'inquiry' | 'media'; resourceID: string }>) {
    try {
      if (marker.resourceType === 'application') { const result = await purgeApplication(payload, marker.resourceID, undefined); if (result.state !== 'completed') throw new Error('Deletion replay could not purge an application.'); applied += 1 }
      else if (marker.resourceType === 'inquiry') { await withPayloadTransaction(payload, async (req) => { req.context.leadSpamDeleteLifecycle = true; await payload.delete({ collection: 'inquiries', id: marker.resourceID, overrideAccess: true, req }); applied += 1 }) }
      else { const result = await purgeMedia(payload, undefined, marker.resourceID); if (result !== 'completed') throw new Error('Deletion replay could not safely purge media.'); applied += 1 }
    } catch (error: unknown) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error }
  }
  return applied
}
