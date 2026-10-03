import { createHash, randomUUID } from 'node:crypto'
import type { Payload, PayloadRequest } from 'payload'
import { hasFreshAuthentication, sessionIsUsable } from './identity'
import { hasRole } from './access'
import { markStaleIfNeeded, snapshot, type CapturedCollection } from './editorial'

type Actor = { id: string; roles?: ('owner' | 'approver' | 'editor' | 'sales' | 'hiring')[] | null; disabled?: boolean | null }
type Change = { collection: CapturedCollection; id: string; after: Record<string, unknown> | null; afterHash: string | null }
type RecordMap = Record<CapturedCollection, Record<string, Record<string, unknown>>>
type ReleaseVersions = { themeVersion: string; engineVersion: string; contractVersion: string }

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  return JSON.stringify(value)
}
export const canonicalHash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex')
export const changeSetHash = (changes: unknown) => canonicalHash(changes)
const idOf = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined

function emptyContent(): RecordMap { return { pages: {}, sections: {}, redirects: {} } }
function tree(content: RecordMap) {
  return Object.values(content.pages).map((page) => ({ id: page.id, parentId: page.parentId ?? null, sectionId: page.sectionId ?? null, slug: page.slug ?? null })).sort((left, right) => String(left.id).localeCompare(String(right.id)))
}

async function baseContent(payload: Payload, req: PayloadRequest): Promise<RecordMap> {
  const published = await payload.find({ collection: 'publish-snapshots', where: { 'manifest.releaseState': { equals: 'published' } }, sort: '-createdAt', limit: 1, depth: 0, overrideAccess: true, req })
  const manifest = published.docs[0]?.manifest as { content?: RecordMap } | undefined
  return manifest?.content ? structuredClone(manifest.content) : emptyContent()
}

export function buildCandidate(base: RecordMap, changes: Change[], includedChangeKeys: readonly string[], versions: ReleaseVersions) {
  const content = structuredClone(base)
  const included = new Set(includedChangeKeys)
  for (const change of changes) {
    const key = `${change.collection}:${change.id}`
    if (!included.has(key)) continue
    if (change.after === null) delete content[change.collection][change.id]
    else content[change.collection][change.id] = { id: change.id, ...change.after }
  }
  return { content, settings: {}, tree: tree(content), media: {}, versions }
}

async function assertFreshReviewer(payload: Payload, req: PayloadRequest, actor: Actor | undefined) {
  if (!actor || actor.disabled || !hasRole(actor, ['owner', 'approver'])) throw new Error('Reviewer role required.')
  const token = req.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(process.env.NODE_ENV === 'production' ? '__Host-site_engine_session=' : 'site_engine_session='))?.split('=')[1]
  if (!token) throw new Error('Fresh authentication is required.')
  const { hashOpaqueToken } = await import('./identity')
  const sessions = await payload.find({ collection: 'auth-sessions', where: { tokenHash: { equals: hashOpaqueToken(token) } }, limit: 1, overrideAccess: true, req })
  const session = sessions.docs[0]
  if (!session || idOf(session.user) !== actor.id || !sessionIsUsable(session) || !hasFreshAuthentication(session)) throw new Error('Fresh authentication is required.')
}

export async function approveChangeSet(input: { payload: Payload; req: PayloadRequest; actor: Actor | undefined; id: string; expectedRevision: number; expectedChangeHash: string; includedChangeKeys: string[]; versions: ReleaseVersions }) {
  const { payload, req, actor, id, expectedRevision, expectedChangeHash, includedChangeKeys, versions } = input
  await assertFreshReviewer(payload, req, actor)
  let set = await payload.findByID({ collection: 'change-sets', id, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>
  set = await markStaleIfNeeded(payload, set, req)
  const changes = Array.isArray(set.changes) ? set.changes as Change[] : []
  if (set.state !== 'submitted') throw new Error(`Cannot approve a ${String(set.state)} change set.`)
  if (Number(set.revision) !== expectedRevision || changeSetHash(changes) !== expectedChangeHash) throw new Error('The reviewed revision no longer matches the submitted change set.')
  const checks = (set.quality as { checks?: { status?: string }[] } | undefined)?.checks
  if (!checks?.length || checks.some((check) => check.status !== 'passed')) throw new Error('Change-set quality checks must pass before approval.')
  if ((set.preview as { status?: string } | undefined)?.status !== 'ready') throw new Error('A ready private preview is required before approval.')
  const known = new Set(changes.map((change) => `${change.collection}:${change.id}`))
  if (!includedChangeKeys.length || includedChangeKeys.some((key) => !known.has(key))) throw new Error('Approval must explicitly include captured changes only.')
  const manifest = buildCandidate(await baseContent(payload, req), changes, includedChangeKeys, versions)
  const contentHash = canonicalHash(manifest)
  const key = `publish:${id}:${expectedRevision}:${contentHash}`
  const existing = await payload.find({ collection: 'publish-outbox', where: { idempotencyKey: { equals: key } }, limit: 1, depth: 0, overrideAccess: true, req })
  if (existing.docs[0]) return { snapshotID: idOf(existing.docs[0].snapshot), outboxID: existing.docs[0].id, idempotencyKey: key }
  const snapshotDoc = await payload.create({ collection: 'publish-snapshots', data: { contentHash, changeSet: id, reviewRevision: expectedRevision, changeHash: expectedChangeHash, manifest: { ...manifest, releaseState: 'approved', includedChangeKeys }, themeVersion: versions.themeVersion, engineVersion: versions.engineVersion, contractVersion: versions.contractVersion, approvedBy: actor!.id }, overrideAccess: true, req, context: { editorialInternal: true } })
  const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: key, snapshot: snapshotDoc.id, changeSet: id, status: 'pending', attempts: 0, correlationID: randomUUID() }, overrideAccess: true, req, context: { editorialInternal: true } })
  await payload.update({ collection: 'change-sets', id, data: { state: 'approved', reviewedAt: new Date().toISOString() }, overrideAccess: true, req, context: { editorialInternal: true } })
  await payload.create({ collection: 'audit-events', data: { event: 'editorial.change_set_approved', user: actor!.id, actor: actor!.id, detail: { changeSet: id, snapshot: snapshotDoc.id, outbox: outbox.id, includedChangeKeys } }, overrideAccess: true, req })
  return { snapshotID: snapshotDoc.id, outboxID: outbox.id, idempotencyKey: key }
}

/** The worker only claims durable work; callers perform network delivery after this returns. */
export async function claimNextPublishJob(payload: Payload, req: PayloadRequest, now = new Date()) {
  const result = await payload.find({ collection: 'publish-outbox', where: { and: [{ status: { in: ['pending', 'failed'] } }, { or: [{ nextAttemptAt: { exists: false } }, { nextAttemptAt: { less_than_equal: now.toISOString() } }] }] }, sort: 'createdAt', limit: 1, depth: 0, overrideAccess: true, req })
  const job = result.docs[0]
  if (!job) return null
  const claimed = await payload.update({ collection: 'publish-outbox', where: { and: [{ id: { equals: job.id } }, { status: { equals: job.status } }] }, data: { status: 'processing', claimedAt: now.toISOString(), attempts: Number(job.attempts ?? 0) + 1 }, overrideAccess: true, req, context: { editorialInternal: true } })
  return claimed.docs[0] ?? null
}

export async function retryPublishJob(payload: Payload, req: PayloadRequest, id: string, reason: string, nextAttemptAt: Date) {
  return payload.update({ collection: 'publish-outbox', id, data: { status: 'failed', lastError: reason.slice(0, 1000), nextAttemptAt: nextAttemptAt.toISOString() }, overrideAccess: true, req, context: { editorialInternal: true } })
}
