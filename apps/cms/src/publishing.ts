import { createHash, randomUUID } from 'node:crypto'
import type { Payload, PayloadRequest } from 'payload'
import { SiteSnapshotSchema, type SiteSnapshot } from '@site-engine/contract'
import { hasRole } from './access'
import { cookieName, hasFreshAuthentication, hashOpaqueToken, readCookie, sessionIsUsable } from './identity'
import { markStaleIfNeeded, type CapturedCollection } from './editorial'

type Actor = { id: string; roles?: ('owner' | 'approver' | 'editor' | 'sales' | 'hiring')[] | null; disabled?: boolean | null }
type Change = { collection: CapturedCollection; id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; afterHash: string | null }
type Versions = { themeVersion: string; engineVersion: string; contractVersion: string }
type Preview = { status?: string; revision?: number; changeHash?: string; includedChangeKeys?: string[]; contentHash?: string }

function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => String(a).localeCompare(String(b))).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`; return JSON.stringify(value) }
export const canonicalHash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex')
export const changeSetHash = (changes: unknown) => canonicalHash(changes)
const idOf = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined
const keysEqual = (left: readonly string[], right: readonly string[]) => stable([...left].sort()) === stable([...right].sort())

async function publishedBaseline(payload: Payload, req: PayloadRequest): Promise<SiteSnapshot | undefined> {
  const releases = await payload.find({ collection: 'published-releases', sort: '-activatedAt', limit: 1, depth: 1, overrideAccess: true, req })
  const source = releases.docs[0]?.snapshot
  const manifest = source && typeof source === 'object' ? source.manifest : undefined
  return manifest ? SiteSnapshotSchema.parse(manifest) : undefined
}

export function buildCandidate(base: SiteSnapshot, changes: Change[], includedChangeKeys: readonly string[], versions: Versions): SiteSnapshot {
  const pages = new Map(base.pages.map((page) => [page.id, structuredClone(page)]))
  const sections = new Map(base.settings.sections.map((section) => [section.id, structuredClone(section)]))
  const redirects = new Map(base.redirects.map((redirect) => [redirect.from, structuredClone(redirect)]))
  const included = new Set(includedChangeKeys)
  for (const change of changes) {
    if (!included.has(`${change.collection}:${change.id}`)) continue
    if (change.collection === 'pages') change.after === null ? pages.delete(change.id) : pages.set(change.id, { id: change.id, ...change.after, status: 'published' } as SiteSnapshot['pages'][number])
    if (change.collection === 'sections') change.after === null ? sections.delete(change.id) : sections.set(change.id, { id: change.id, ...change.after } as SiteSnapshot['settings']['sections'][number])
    if (change.collection === 'redirects') {
      if (change.after === null) redirects.delete(String(change.before?.from))
      else {
        if (change.before?.from && change.before.from !== change.after.from) redirects.delete(String(change.before.from))
        redirects.set(String(change.after.from), change.after as SiteSnapshot['redirects'][number])
      }
    }
  }
  for (const section of sections.values()) section.pageIds = [...pages.values()].filter((page) => page.sectionId === section.id).map((page) => page.id).sort()
  return SiteSnapshotSchema.parse({ ...structuredClone(base), settings: { ...structuredClone(base.settings), contractVersion: versions.contractVersion, sections: [...sections.values()].sort((a, b) => a.id.localeCompare(b.id)) }, pages: [...pages.values()].sort((a, b) => a.id.localeCompare(b.id)), redirects: [...redirects.values()].sort((a, b) => a.from.localeCompare(b.from)), media: structuredClone(base.media), changeSets: [] })
}

async function canonicalReviewer(payload: Payload, req: PayloadRequest, actor: Actor | undefined): Promise<Actor> {
  if (!actor?.id) throw new Error('Reviewer role required.')
  const user = await payload.findByID({ collection: 'users', id: actor.id, overrideAccess: true, req }) as unknown as Actor
  if (!hasRole(user, ['owner', 'approver'])) throw new Error('Reviewer role required.')
  const token = readCookie(req.headers, cookieName('__Host-site_engine_session'))
  if (!token) throw new Error('Fresh authentication is required.')
  const sessions = await payload.find({ collection: 'auth-sessions', where: { tokenHash: { equals: hashOpaqueToken(token) } }, limit: 1, overrideAccess: true, req })
  const session = sessions.docs[0]
  if (!session || idOf(session.user) !== actor.id || !sessionIsUsable(session) || !hasFreshAuthentication(session)) throw new Error('Fresh authentication is required.')
  return user
}

export async function approveChangeSet(input: { payload: Payload; req: PayloadRequest; actor: Actor | undefined; id: string; expectedRevision: number; expectedChangeHash: string; includedChangeKeys: string[]; previewContentHash: string; versions: Versions; initialBaseline?: SiteSnapshot }) {
  const { payload, req, actor, id, expectedRevision, expectedChangeHash, includedChangeKeys, previewContentHash, versions, initialBaseline } = input
  if (!req.transactionID) throw new Error('Approval must run inside a database transaction.')
  const reviewer = await canonicalReviewer(payload, req, actor)
  const idempotencyKey = `publish:${id}:${expectedRevision}:${previewContentHash}`
  const existing = await payload.find({ collection: 'publish-outbox', where: { idempotencyKey: { equals: idempotencyKey } }, limit: 1, depth: 1, overrideAccess: true, req })
  if (existing.docs[0]) {
    const source = existing.docs[0].snapshot
    const approvedBy = idOf(source && typeof source === 'object' ? source.approvedBy : undefined)
    if (approvedBy !== reviewer.id) throw new Error('This approval belongs to a different reviewer.')
    if (Number(existing.docs[0].reviewRevision) !== expectedRevision || existing.docs[0].changeHash !== expectedChangeHash || !Array.isArray(existing.docs[0].includedChangeKeys) || !keysEqual(existing.docs[0].includedChangeKeys as string[], includedChangeKeys) || !source || typeof source !== 'object' || source.contentHash !== previewContentHash || source.themeVersion !== versions.themeVersion || source.engineVersion !== versions.engineVersion || source.contractVersion !== versions.contractVersion) throw new Error('The idempotent approval request no longer matches its persisted snapshot.')
    return { snapshotID: idOf(source), outboxID: existing.docs[0].id, idempotencyKey }
  }
  let set = await payload.findByID({ collection: 'change-sets', id, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>
  set = await markStaleIfNeeded(payload, set, req)
  const changes = Array.isArray(set.changes) ? set.changes as Change[] : []
  if (set.state !== 'submitted') throw new Error(`Cannot approve a ${String(set.state)} change set.`)
  if (Number(set.revision) !== expectedRevision || changeSetHash(changes) !== expectedChangeHash) throw new Error('The reviewed revision no longer matches the submitted change set.')
  const checks = (set.quality as { checks?: { status?: string }[] } | undefined)?.checks
  if (!checks?.length || checks.some((check) => check.status !== 'passed')) throw new Error('Change-set quality checks must pass before approval.')
  const known = new Set(changes.map((change) => `${change.collection}:${change.id}`))
  if (!includedChangeKeys.length || new Set(includedChangeKeys).size !== includedChangeKeys.length || includedChangeKeys.some((key) => !known.has(key))) throw new Error('Approval must explicitly include unique captured changes only.')
  const base = await publishedBaseline(payload, req) ?? initialBaseline
  if (!base) throw new Error('An initial contract-valid baseline is required before approval.')
  const candidate = buildCandidate(base, changes, includedChangeKeys, versions)
  const contentHash = canonicalHash(candidate)
  const preview = set.preview as Preview | undefined
  if (preview?.status !== 'ready' || preview.revision !== expectedRevision || preview.changeHash !== expectedChangeHash || preview.contentHash !== contentHash || preview.contentHash !== previewContentHash || !Array.isArray(preview.includedChangeKeys) || !keysEqual(preview.includedChangeKeys, includedChangeKeys)) throw new Error('A ready private preview for this exact candidate is required before approval.')
  const excluded = changes.filter((change) => !includedChangeKeys.includes(`${change.collection}:${change.id}`))
  if (excluded.length) await payload.create({ collection: 'change-sets', data: { name: `${String(set.name)} — remaining changes`, actor: idOf(set.actor), state: 'open', revision: 0, changes: excluded }, overrideAccess: true, req, context: { editorialInternal: true } })
  const snapshotDoc = await payload.create({ collection: 'publish-snapshots', data: { contentHash, changeSet: id, reviewRevision: expectedRevision, changeHash: expectedChangeHash, manifest: candidate, themeVersion: versions.themeVersion, engineVersion: versions.engineVersion, contractVersion: versions.contractVersion, approvedBy: reviewer.id }, overrideAccess: true, req, context: { editorialInternal: true } })
  const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey, snapshot: snapshotDoc.id, changeSet: id, reviewRevision: expectedRevision, changeHash: expectedChangeHash, includedChangeKeys, status: 'pending', attempts: 0, correlationID: randomUUID() }, overrideAccess: true, req, context: { editorialInternal: true } })
  await payload.update({ collection: 'change-sets', id, data: { state: 'approved', changes: changes.filter((change) => includedChangeKeys.includes(`${change.collection}:${change.id}`)), reviewedAt: new Date().toISOString() }, overrideAccess: true, req, context: { editorialInternal: true } })
  await payload.create({ collection: 'audit-events', data: { event: 'editorial.change_set_approved', user: reviewer.id, actor: reviewer.id, detail: { changeSet: id, snapshot: snapshotDoc.id, outbox: outbox.id, includedChangeKeys } }, overrideAccess: true, req })
  return { snapshotID: snapshotDoc.id, outboxID: outbox.id, idempotencyKey }
}

export async function claimNextPublishJob(payload: Payload, req: PayloadRequest, now = new Date()) { const result = await payload.find({ collection: 'publish-outbox', where: { and: [{ status: { in: ['pending', 'failed'] } }, { or: [{ nextAttemptAt: { exists: false } }, { nextAttemptAt: { less_than_equal: now.toISOString() } }] }] }, sort: 'createdAt', limit: 1, depth: 0, overrideAccess: true, req }); const job = result.docs[0]; if (!job) return null; const claimed = await payload.update({ collection: 'publish-outbox', where: { and: [{ id: { equals: job.id } }, { status: { equals: job.status } }] }, data: { status: 'processing', claimedAt: now.toISOString(), attempts: Number(job.attempts ?? 0) + 1 }, overrideAccess: true, req, context: { editorialInternal: true } }); return claimed.docs[0] ?? null }
export async function retryPublishJob(payload: Payload, req: PayloadRequest, id: string, reason: string, nextAttemptAt: Date) { return payload.update({ collection: 'publish-outbox', id, data: { status: 'failed', lastError: reason.slice(0, 1000), nextAttemptAt: nextAttemptAt.toISOString() }, overrideAccess: true, req, context: { editorialInternal: true } }) }
