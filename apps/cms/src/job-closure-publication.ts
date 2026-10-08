import { createHash, randomUUID } from 'node:crypto'
import type { Payload, PayloadRequest } from 'payload'
import { SiteSnapshotSchema, type SiteSnapshot } from '@site-engine/contract'
import { checkSiteSnapshot } from '@site-engine/checks'

type RecordValue = Record<string, unknown>
type PublishedBaseline = { releaseID: string; snapshotID: string; sequence: number; manifest: SiteSnapshot; snapshot: RecordValue }

const idOf = (value: unknown): string | undefined => typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value as RecordValue).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value)
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex')
const closureKey = (pageID: string, validThrough: string, baseline: PublishedBaseline) => `job-close:${pageID}:${validThrough}:${baseline.snapshotID}:${baseline.sequence}`

async function auditOnce(payload: Payload, req: PayloadRequest, event: string, detail: RecordValue) {
  const existing = await payload.find({ collection: 'audit-events', where: { and: [{ event: { equals: event } }, { 'detail.idempotencyKey': { equals: detail.idempotencyKey } }] }, limit: 1, depth: 0, overrideAccess: true, req })
  if (existing.docs[0]) return
  await payload.create({ collection: 'audit-events', data: { event, detail }, overrideAccess: true, req })
}

async function currentPublishedBaseline(payload: Payload, req: PayloadRequest): Promise<PublishedBaseline | undefined> {
  const releases = await payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true, req })
  const release = releases.docs[0] as unknown as RecordValue | undefined
  const snapshot = release?.snapshot && typeof release.snapshot === 'object' ? release.snapshot as RecordValue : undefined
  const snapshotID = idOf(snapshot)
  if (!release || !snapshot || !snapshotID || !snapshot.manifest) return undefined
  return { releaseID: String(release.id), snapshotID, sequence: Number(release.sequence), manifest: SiteSnapshotSchema.parse(snapshot.manifest), snapshot }
}

function expiredPublishedJobs(manifest: SiteSnapshot, now: Date) {
  return manifest.pages.flatMap((page) => {
    const validThrough = page.template === 'job' ? page.jobPosting?.validThrough : undefined
    return page.status === 'published' && typeof validThrough === 'string' && Date.parse(validThrough) <= now.getTime()
      ? [{ page, validThrough: new Date(validThrough).toISOString() }]
      : []
  })
}

async function settleBlockedClosures(payload: Payload, req: PayloadRequest, baseline: PublishedBaseline, now: Date, reason: string) {
  for (const { page, validThrough } of expiredPublishedJobs(baseline.manifest, now)) {
    const idempotencyKey = closureKey(page.id, validThrough, baseline)
    await auditOnce(payload, req, 'editorial.job_closure_deferred', { idempotencyKey, page: page.id, validThrough, release: baseline.releaseID, baselineSnapshot: baseline.snapshotID, baselineSequence: baseline.sequence, reason })
  }
}

/**
 * Enqueues deterministic withdrawals only after all existing publication work has settled.
 * The candidate is derived exclusively from the active immutable release; it never reads
 * working page content, so an unpublished edit cannot leak into an automatic closure.
 */
export async function dispatchExpiredJobClosures(payload: Payload, req: PayloadRequest, now = new Date()) {
  if (!req.transactionID) throw new Error('Job closure dispatch must run inside a database transaction.')
  const baseline = await currentPublishedBaseline(payload, req)
  if (!baseline) return { enqueued: 0, deferred: 0, blocked: 0 }
  const expired = expiredPublishedJobs(baseline.manifest, now)
  if (!expired.length) return { enqueued: 0, deferred: 0, blocked: 0 }

  const unsettled = await payload.find({ collection: 'publish-outbox', where: { and: [{ sequence: { greater_than: baseline.sequence } }, { status: { in: ['pending', 'processing', 'failed'] } }] }, limit: 1, depth: 0, overrideAccess: true, req })
  if (unsettled.docs[0]) {
    await settleBlockedClosures(payload, req, baseline, now, 'PUBLICATION_QUEUE_UNSETTLED')
    return { enqueued: 0, deferred: expired.length, blocked: 0 }
  }

  let blocked = 0
  const closable: typeof expired = []
  for (const { page, validThrough } of expired) {
    const idempotencyKey = closureKey(page.id, validThrough, baseline)
    const existing = await payload.find({ collection: 'publish-outbox', where: { idempotencyKey: { equals: idempotencyKey } }, limit: 1, depth: 1, overrideAccess: true, req })
    if (existing.docs[0]) continue

    const approvedBy = idOf(baseline.snapshot.approvedBy)
    let livePage: RecordValue | undefined
    try { livePage = await payload.findByID({ collection: 'pages', id: page.id, depth: 0, draft: true, overrideAccess: true, req }) as unknown as RecordValue } catch { /* controlled below */ }
    let approver: RecordValue | undefined
    try { if (approvedBy) approver = await payload.findByID({ collection: 'users', id: approvedBy, depth: 0, overrideAccess: true, req }) as unknown as RecordValue } catch { /* controlled below */ }
    if (!approvedBy || !approver || !livePage) {
      await auditOnce(payload, req, 'editorial.job_closure_blocked', { idempotencyKey, page: page.id, validThrough, release: baseline.releaseID, baselineSnapshot: baseline.snapshotID, baselineSequence: baseline.sequence, reason: !approvedBy || !approver ? 'ORIGINAL_APPROVAL_REFERENCE_MISSING' : 'LIVE_PAGE_REFERENCE_MISSING' })
      blocked += 1
      continue
    }

    closable.push({ page, validThrough })
  }
  if (!closable.length) return { enqueued: 0, deferred: 0, blocked }
  const candidate = structuredClone(baseline.manifest)
  const changes = closable.map(({ page }) => {
    const candidatePage = candidate.pages.find((item) => item.id === page.id)!
    candidatePage.status = 'archived'
    return { collection: 'pages', id: page.id, before: structuredClone(page), after: structuredClone(candidatePage), beforeHash: hash(page), afterHash: hash(candidatePage) }
  })
  const batchKey = `job-close-batch:${baseline.snapshotID}:${baseline.sequence}:${hash(closable.map(({ page, validThrough }) => [page.id, validThrough]))}`
  const alreadyEnqueued = await payload.find({ collection: 'publish-outbox', where: { idempotencyKey: { equals: batchKey } }, limit: 1, depth: 0, overrideAccess: true, req })
  if (alreadyEnqueued.docs[0]) return { enqueued: 0, deferred: 0, blocked }
  if (!checkSiteSnapshot(candidate, { style: candidate.styleGuide }).publishable) {
    for (const { page, validThrough } of closable) await auditOnce(payload, req, 'editorial.job_closure_blocked', { idempotencyKey: closureKey(page.id, validThrough, baseline), page: page.id, validThrough, release: baseline.releaseID, baselineSnapshot: baseline.snapshotID, baselineSequence: baseline.sequence, reason: 'CLOSURE_CANDIDATE_INVALID' })
    return { enqueued: 0, deferred: 0, blocked: blocked + closable.length }
  }
  // `approvedBy` records who approved the already-published deadline. It is
  // retained as immutable deadline provenance, not treated as a fresh human
  // approval for the system-enforced withdrawal.
  const approvedBy = idOf(baseline.snapshot.approvedBy)!
  const changeHash = hash(changes)
  const changeSet = await payload.create({ collection: 'change-sets', data: { name: `Automatic closure: ${closable.length} expired role${closable.length === 1 ? '' : 's'}`, actor: approvedBy, state: 'approved', revision: 0, changes, summary: `System withdrawal at ${now.toISOString()} from published release ${baseline.sequence}.` }, overrideAccess: true, req, context: { editorialInternal: true } })
  const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: hash(candidate), changeSet: changeSet.id, reviewRevision: 0, changeHash, manifest: candidate, themeVersion: String(baseline.snapshot.themeVersion), engineVersion: String(baseline.snapshot.engineVersion), contractVersion: String(baseline.snapshot.contractVersion), approvedBy, baselineSnapshot: baseline.snapshotID, baselineSequence: baseline.sequence }, overrideAccess: true, req, context: { editorialInternal: true } })
  const newest = await payload.find({ collection: 'publish-outbox', sort: '-sequence', limit: 1, depth: 0, overrideAccess: true, req })
  const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: batchKey, sequence: Number(newest.docs[0]?.sequence ?? 0) + 1, snapshot: snapshot.id, changeSet: changeSet.id, reviewRevision: 0, changeHash, includedChangeKeys: closable.map(({ page }) => `pages:${page.id}`), status: 'pending', attempts: 0, correlationID: randomUUID() }, overrideAccess: true, req, context: { editorialInternal: true } })
  const openSets = await payload.find({ collection: 'change-sets', where: { state: { in: ['open', 'submitted', 'changes-requested'] } }, limit: 0, pagination: false, depth: 0, overrideAccess: true, req })
  for (const { page, validThrough } of closable) {
    await payload.update({ collection: 'pages', id: page.id, data: { status: 'archived' }, draft: true, overrideAccess: true, req, context: { editorialInternal: true, archiveInternal: true } })
    const staleSets = (openSets.docs as unknown as RecordValue[]).filter((set) => Array.isArray(set.changes) && (set.changes as RecordValue[]).some((item) => item.collection === 'pages' && item.id === page.id))
    for (const set of staleSets) await payload.update({ collection: 'change-sets', id: String(set.id), data: { state: 'stale', staleAt: now.toISOString(), preview: null, quality: null }, overrideAccess: true, req, context: { editorialInternal: true } })
    await payload.create({ collection: 'audit-events', data: { event: 'editorial.job_closed', detail: { idempotencyKey: closureKey(page.id, validThrough, baseline), batchKey, page: page.id, validThrough, release: baseline.releaseID, baselineSnapshot: baseline.snapshotID, baselineSequence: baseline.sequence, changeSet: changeSet.id, snapshot: snapshot.id, outbox: outbox.id, executor: 'system', deadlineApprovedBy: approvedBy, reason: 'VALID_THROUGH_ELAPSED', staleChangeSets: staleSets.map((set) => set.id) } }, overrideAccess: true, req })
  }
  return { enqueued: 1, deferred: 0, blocked }
}
