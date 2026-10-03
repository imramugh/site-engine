import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Payload, PayloadRequest } from 'payload'
import { SiteSnapshotSchema, type SiteSnapshot } from '@site-engine/contract'
import { hasRole } from './access'
import { cookieName, hasFreshAuthentication, hashOpaqueToken, readCookie, sessionIsUsable, SESSION_COOKIE } from './identity'
import { markStaleIfNeeded, snapshot as capturedSnapshot, type CapturedCollection } from './editorial'
import { validateRedirectSet } from './redirect-lifecycle'
import { deriveRoutes } from '@site-engine/engine'

type Actor = { id: string; roles?: ('owner' | 'approver' | 'editor' | 'sales' | 'hiring')[] | null; disabled?: boolean | null }
type Change = { collection: CapturedCollection; id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; beforeHash: string | null; afterHash: string | null }
type Versions = { themeVersion: string; engineVersion: string; contractVersion: string }
type Preview = { status?: string; revision?: number; changeHash?: string; includedChangeKeys?: string[]; contentHash?: string; baselineSnapshotID?: string; baselineSequence?: number }
export type VerifiedArtifact = { digest: string; sourceContentHash: string; themeVersion: string; engineVersion: string; contractVersion: string; checks: { name: string; status: 'passed' }[] }
export const REQUIRED_PUBLISH_HEALTH_CHECKS = ['artifact-integrity', 'public-health'] as const
const MAX_PUBLISH_ATTEMPTS = 3
const MAX_PUBLISH_WORKER_BODY_BYTES = 16 * 1024

function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => String(a).localeCompare(String(b))).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`; return JSON.stringify(value) }
export const canonicalHash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex')
export const changeSetHash = (changes: unknown) => canonicalHash(changes)
const idOf = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined
const keysEqual = (left: readonly string[], right: readonly string[]) => stable([...left].sort()) === stable([...right].sort())
const requireTransaction = (req: PayloadRequest, operation: string) => { if (!req.transactionID) throw new Error(`${operation} must run inside a database transaction.`) }
const cleanErrorCode = (value: string) => /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'PUBLISH_FAILED'
export function scheduledPublicationTime(value: unknown, now = Date.now()): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new Error('scheduledFor must be a UTC ISO timestamp.')
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== (value.includes('.') ? value : `${value.slice(0, -1)}.000Z`)) throw new Error('scheduledFor must be a UTC ISO timestamp.')
  if (timestamp <= now) throw new Error('scheduledFor must be in the future.')
  return new Date(timestamp).toISOString()
}
function exactQualityProof(quality: unknown, expected: { revision: number; changeHash: string; contentHash: string; includedChangeKeys: readonly string[]; baselineSnapshotID?: string; baselineSequence: number; previewJobID?: string }): boolean {
  const proof = quality && typeof quality === 'object' ? (quality as { proof?: Record<string, unknown> }).proof : undefined
  const report = proof?.report as { publishable?: unknown } | undefined
  return Boolean(proof && report?.publishable === true && proof.revision === expected.revision && proof.changeHash === expected.changeHash && proof.contentHash === expected.contentHash && proof.baselineSnapshotID === expected.baselineSnapshotID && proof.baselineSequence === expected.baselineSequence && (expected.previewJobID === undefined || proof.previewJobID === expected.previewJobID) && Array.isArray(proof.includedChangeKeys) && keysEqual(proof.includedChangeKeys.filter((value): value is string => typeof value === 'string'), expected.includedChangeKeys))
}

async function nextOutboxSequence(payload: Payload, req: PayloadRequest): Promise<number> {
  const newest = await payload.find({ collection: 'publish-outbox', sort: '-sequence', limit: 1, depth: 0, overrideAccess: true, req })
  return Number(newest.docs[0]?.sequence ?? 0) + 1
}

type Baseline = { manifest: SiteSnapshot; snapshotID?: string; sequence: number }

async function publishedBaseline(payload: Payload, req: PayloadRequest): Promise<Baseline | undefined> {
  const releases = await payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true, req })
  const source = releases.docs[0]?.snapshot
  const manifest = source && typeof source === 'object' ? source.manifest : undefined
  return manifest ? { manifest: SiteSnapshotSchema.parse(manifest), snapshotID: idOf(source), sequence: Number(releases.docs[0]?.sequence ?? 0) } : undefined
}

/** The queue head is the next publication baseline, even before it is public. */
async function approvalBaseline(payload: Payload, req: PayloadRequest, initialBaseline?: SiteSnapshot): Promise<Baseline | undefined> {
  const queued = await payload.find({ collection: 'publish-outbox', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true, req })
  const snapshot = queued.docs[0]?.snapshot
  const manifest = snapshot && typeof snapshot === 'object' ? snapshot.manifest : undefined
  if (manifest) return { manifest: SiteSnapshotSchema.parse(manifest), snapshotID: idOf(snapshot), sequence: Number(queued.docs[0]?.sequence ?? 0) }
  return await publishedBaseline(payload, req) ?? (initialBaseline ? { manifest: initialBaseline, sequence: 0 } : undefined)
}

const owns = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const same = (left: unknown, right: unknown) => stable(left) === stable(right)

/** Applies only fields changed by the editor, preserving independently queued fields. */
function mergeCapturedChange(current: Record<string, unknown> | undefined, change: Change): Record<string, unknown> | null {
  if (change.before === null) {
    if (current) throw new Error('This approval would overwrite a record in the queued baseline. Refresh the change set before approval.')
    return change.after === null ? null : structuredClone(change.after)
  }
  if (!change.beforeHash || canonicalHash(change.before) !== change.beforeHash) throw new Error('The captured baseline is invalid. Refresh the change set before approval.')
  if (!current) throw new Error('This approval does not apply to the queued baseline. Refresh the change set before approval.')
  const currentSnapshot = capturedSnapshot(change.collection, current)
  if (!currentSnapshot) throw new Error('This approval does not apply to the queued baseline. Refresh the change set before approval.')
  if (change.after === null) {
    if (!same(currentSnapshot, change.before)) throw new Error('This approval conflicts with the queued baseline. Refresh the change set before approval.')
    return null
  }
  const merged = structuredClone(current)
  for (const key of new Set([...Object.keys(change.before), ...Object.keys(change.after)])) {
    const before = owns(change.before, key) ? change.before[key] : undefined
    const after = owns(change.after, key) ? change.after[key] : undefined
    if (same(before, after)) continue
    const baseline = owns(currentSnapshot, key) ? currentSnapshot[key] : undefined
    if (!same(baseline, before) && !same(baseline, after)) throw new Error('This approval conflicts with the queued baseline. Refresh the change set before approval.')
    if (same(baseline, after)) continue
    if (owns(change.after, key)) merged[key] = structuredClone(after)
    else delete merged[key]
  }
  return merged
}

export function buildCandidate(base: SiteSnapshot, changes: Change[], includedChangeKeys: readonly string[], versions: Versions): SiteSnapshot {
  const pages = new Map(base.pages.map((page) => [page.id, structuredClone(page)]))
  const sections = new Map(base.settings.sections.map((section) => [section.id, structuredClone(section)]))
  const redirects = new Map(base.redirects.map((redirect) => [redirect.from, structuredClone(redirect)]))
  const media = new Map(base.media.map((asset) => [asset.id, structuredClone(asset)]))
  let selectedTheme = structuredClone(base.settings.theme); const themeSettings = structuredClone(base.settings.themeSettings ?? {})
  let siteSettings = structuredClone(base.settings) as Record<string, unknown>
  let styleGuide = structuredClone(base.styleGuide) as Record<string, unknown> | undefined
  const included = new Set(includedChangeKeys)
  for (const change of changes) {
    if (!included.has(`${change.collection}:${change.id}`)) continue
    if (change.collection === 'pages') {
      const merged = mergeCapturedChange(pages.get(change.id) as Record<string, unknown> | undefined, change)
      merged === null ? pages.delete(change.id) : pages.set(change.id, { id: change.id, ...merged, status: merged.status === 'archived' ? 'archived' : 'published' } as SiteSnapshot['pages'][number])
    }
    if (change.collection === 'sections') {
      const merged = mergeCapturedChange(sections.get(change.id) as Record<string, unknown> | undefined, change)
      merged === null ? sections.delete(change.id) : sections.set(change.id, { id: change.id, ...merged } as SiteSnapshot['settings']['sections'][number])
    }
    if (change.collection === 'redirects') {
      const original = String(change.before?.from ?? change.id)
      const merged = mergeCapturedChange(redirects.get(original) as Record<string, unknown> | undefined, change)
      if (merged === null) redirects.delete(original)
      else {
        redirects.delete(original)
        redirects.set(String(merged.from), merged as SiteSnapshot['redirects'][number])
      }
    }
    if (change.collection === 'theme-settings') {
      // A site can already retain namespaced settings before the singleton
      // theme-settings record is first created. That creation supplies the
      // selection while preserving those baseline namespaces.
      const merged = change.before === null
        ? { selection: selectedTheme, settings: themeSettings, ...structuredClone(change.after) }
        : mergeCapturedChange({ selection: selectedTheme, settings: themeSettings }, change)
      if (!merged?.selection) throw new Error('Theme selection cannot be removed.')
      selectedTheme = merged.selection as SiteSnapshot['settings']['theme']; Object.assign(themeSettings, merged.settings as Record<string, unknown>)
    }
    if (change.collection === 'site-settings') {
      // The singleton may be introduced after a baseline exists. Apply only its
      // reviewed fields so sections, operator contract pins, and theme data stay intact.
      const merged = change.before === null
        ? { ...siteSettings, ...structuredClone(change.after) }
        : mergeCapturedChange(siteSettings, change)
      if (!merged) throw new Error('Site settings cannot be removed.')
      siteSettings = merged
    }
    if (change.collection === 'style-guides') {
      const merged = change.before === null
        ? structuredClone(change.after)
        : mergeCapturedChange(styleGuide, change)
      if (!merged) throw new Error('Style guide cannot be removed.')
      styleGuide = merged
    }
    if (change.collection === 'assets') {
      const merged = mergeCapturedChange(media.get(change.id) as Record<string, unknown> | undefined, change)
      if (merged === null) media.delete(change.id)
      else media.set(change.id, { id: change.id, ...merged } as SiteSnapshot['media'][number])
    }
  }
  if (typeof siteSettings.logo === 'string') {
    const logo = media.get(siteSettings.logo)
    if (!logo) throw new Error('Site settings logo must reference an included asset.')
    siteSettings.logo = logo
  }
  // Payload represents omitted optional singleton fields as null. The public
  // snapshot contract intentionally represents omission, not nullability.
  for (const field of ['homepageId', 'logo', 'organizationType', 'contactEmail', 'contactPhone', 'seoDescription']) {
    if (siteSettings[field] === null) delete siteSettings[field]
  }
  // Keep editor-maintained navigation distinct from derived section membership.
  // Captures use null to represent an explicit editor clear. The immutable
  // public contract represents optional page metadata by omission.
  const candidatePages = [...pages.values()].map((page) => {
    if (page.seoDescription !== null) return page
    const { seoDescription: _seoDescription, ...withoutSEODescription } = page
    return withoutSEODescription
  })
  const candidate = SiteSnapshotSchema.parse({ ...structuredClone(base), settings: { ...siteSettings, contractVersion: versions.contractVersion, ...(selectedTheme ? { theme: selectedTheme } : {}), themeSettings, sections: [...sections.values()].sort((a, b) => a.id.localeCompare(b.id)) }, ...(styleGuide ? { styleGuide } : {}), pages: candidatePages.sort((a, b) => a.id.localeCompare(b.id)), redirects: [...redirects.values()].sort((a, b) => a.from.localeCompare(b.from)), media: [...media.values()].sort((a, b) => a.id.localeCompare(b.id)), changeSets: [] })
  const oldRoutes = deriveRoutes(base).routes
  const newRoutes = deriveRoutes(candidate).routes
  const occupiedPaths = new Set(newRoutes.map(route => route.path))
  const nextByID = new Map(newRoutes.map((route) => [route.page.id, route]))
  const transitions = new Map(oldRoutes.flatMap((route) => {
    const next = nextByID.get(route.page.id)
    return next && next.path !== route.path && !occupiedPaths.has(route.path) ? [[route.path, next.path] as const] : []
  }))
  const redirectsWithMovedTargets = candidate.redirects.map((redirect) => ({ ...redirect, to: transitions.get(redirect.to) ?? redirect.to }))
  const addRedirect = (redirect: { from: string; to: string; status: 301 }) => {
    const existing = redirectsWithMovedTargets.find((candidateRedirect) => candidateRedirect.from === redirect.from)
    if (!existing) { redirectsWithMovedTargets.push(redirect); return }
    if (existing.to !== redirect.to) throw new Error(`Redirect ${redirect.from} already has a different target.`)
  }
  for (const oldRoute of oldRoutes) {
    const next = nextByID.get(oldRoute.page.id)
    // A reviewed homepage replacement keeps '/' occupied by the new page.
    // Redirect only vacated paths, never shadow a route in the new snapshot.
    if (next && next.path !== oldRoute.path && !occupiedPaths.has(oldRoute.path)) addRedirect({ from: oldRoute.path, to: next.path, status: 301 })
    if (!next && candidate.pages.find((page) => page.id === oldRoute.page.id)?.status === 'archived' && !occupiedPaths.has(oldRoute.path)) {
      // An editor-selected redirect is authoritative. Only derive the parent
      // destination when the old route has no selected redirect at all.
      if (redirectsWithMovedTargets.some((redirect) => redirect.from === oldRoute.path)) continue
      const parentID = oldRoute.page.parentId
      const target = parentID ? nextByID.get(parentID)?.path : undefined
      if (!target) throw new Error(`Archiving ${oldRoute.path} requires an explicit redirect target.`)
      addRedirect({ from: oldRoute.path, to: target, status: 301 })
    }
  }
  return SiteSnapshotSchema.parse({ ...candidate, redirects: validateRedirectSet(redirectsWithMovedTargets) })
}

async function canonicalReviewer(payload: Payload, req: PayloadRequest, actor: Actor | undefined): Promise<Actor> {
  if (!actor?.id) throw new Error('Reviewer role required.')
  const user = await payload.findByID({ collection: 'users', id: actor.id, overrideAccess: true, req }) as unknown as Actor
  if (!hasRole(user, ['owner', 'approver'])) throw new Error('Reviewer role required.')
  const token = readCookie(req.headers, cookieName(SESSION_COOKIE))
  if (!token) throw new Error('Fresh authentication is required.')
  const sessions = await payload.find({ collection: 'auth-sessions', where: { tokenHash: { equals: hashOpaqueToken(token) } }, limit: 1, overrideAccess: true, req })
  const session = sessions.docs[0]
  if (!session || idOf(session.user) !== actor.id || !sessionIsUsable(session) || !hasFreshAuthentication(session)) throw new Error('Fresh authentication is required.')
  return user
}

async function canonicalOwner(payload: Payload, req: PayloadRequest, actor: Actor | undefined): Promise<Actor> {
  if (!actor?.id) throw new Error('Owner role required.')
  const user = await payload.findByID({ collection: 'users', id: actor.id, overrideAccess: true, req }) as unknown as Actor
  if (!hasRole(user, ['owner'])) throw new Error('Owner role required.')
  const token = readCookie(req.headers, cookieName(SESSION_COOKIE))
  if (!token) throw new Error('Fresh authentication is required.')
  const sessions = await payload.find({ collection: 'auth-sessions', where: { tokenHash: { equals: hashOpaqueToken(token) } }, limit: 1, overrideAccess: true, req })
  const session = sessions.docs[0]
  if (!session || idOf(session.user) !== actor.id || !sessionIsUsable(session) || !hasFreshAuthentication(session)) throw new Error('Fresh authentication is required.')
  return user
}

export async function approveChangeSet(input: { payload: Payload; req: PayloadRequest; actor: Actor | undefined; id: string; expectedRevision: number; expectedChangeHash: string; includedChangeKeys: string[]; previewContentHash: string; previewJobID?: string; versions: Versions; initialBaseline?: SiteSnapshot; scheduledFor?: string }) {
  const { payload, req, actor, id, expectedRevision, expectedChangeHash, includedChangeKeys, previewContentHash, versions, initialBaseline } = input
  requireTransaction(req, 'Approval')
  const reviewer = await canonicalReviewer(payload, req, actor)
  if (!includedChangeKeys.length || new Set(includedChangeKeys).size !== includedChangeKeys.length) throw new Error('Approval must explicitly include unique captured changes only.')
  const scheduledFor = scheduledPublicationTime(input.scheduledFor)
  const idempotencyKey = `publish:${id}:${expectedRevision}:${previewContentHash}`
  const existing = await payload.find({ collection: 'publish-outbox', where: { idempotencyKey: { equals: idempotencyKey } }, limit: 1, depth: 1, overrideAccess: true, req })
  if (existing.docs[0]) {
    const source = existing.docs[0].snapshot
    const approvedBy = idOf(source && typeof source === 'object' ? source.approvedBy : undefined)
    if (approvedBy !== reviewer.id) throw new Error('This approval belongs to a different reviewer.')
    if (Number(existing.docs[0].reviewRevision) !== expectedRevision || existing.docs[0].changeHash !== expectedChangeHash || !Array.isArray(existing.docs[0].includedChangeKeys) || !keysEqual(existing.docs[0].includedChangeKeys as string[], includedChangeKeys) || !source || typeof source !== 'object' || source.contentHash !== previewContentHash || source.themeVersion !== versions.themeVersion || source.engineVersion !== versions.engineVersion || source.contractVersion !== versions.contractVersion) throw new Error('The idempotent approval request no longer matches its persisted snapshot.')
    return { snapshotID: idOf(source), outboxID: existing.docs[0].id, idempotencyKey }
  }
  const existingSchedule = await payload.find({ collection: 'scheduled-publications', where: { idempotencyKey: { equals: idempotencyKey } }, limit: 1, depth: 1, overrideAccess: true, req })
  if (existingSchedule.docs[0]) {
    const schedule = existingSchedule.docs[0]
    const source = schedule.snapshot
    const approvedBy = idOf(source && typeof source === 'object' ? source.approvedBy : undefined)
    const proof = schedule.proof as Record<string, unknown> | undefined
    if (!scheduledFor || approvedBy !== reviewer.id || String(schedule.scheduledFor) !== scheduledFor || !source || typeof source !== 'object' || source.contentHash !== previewContentHash || source.themeVersion !== versions.themeVersion || source.engineVersion !== versions.engineVersion || source.contractVersion !== versions.contractVersion || proof?.idempotencyKey !== idempotencyKey || proof?.changeHash !== expectedChangeHash || proof?.reviewRevision !== expectedRevision || !Array.isArray(proof?.includedChangeKeys) || !keysEqual(proof.includedChangeKeys.filter((key): key is string => typeof key === 'string'), includedChangeKeys)) throw new Error('The idempotent approval request no longer matches its persisted snapshot.')
    return { snapshotID: idOf(source), scheduledPublicationID: schedule.id, idempotencyKey, scheduledFor }
  }
  let set = await payload.findByID({ collection: 'change-sets', id, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>
  set = await markStaleIfNeeded(payload, set, req)
  const changes = Array.isArray(set.changes) ? set.changes as Change[] : []
  if (set.state !== 'submitted') throw new Error(`Cannot approve a ${String(set.state)} change set.`)
  if (Number(set.revision) !== expectedRevision || changeSetHash(changes) !== expectedChangeHash) throw new Error('The reviewed revision no longer matches the submitted change set.')
  const known = new Set(changes.map((change) => `${change.collection}:${change.id}`))
  if (includedChangeKeys.some((key) => !known.has(key))) throw new Error('Approval must explicitly include unique captured changes only.')
  const baseline = await approvalBaseline(payload, req, initialBaseline)
  if (!baseline) throw new Error('An initial contract-valid baseline is required before approval.')
  const candidate = buildCandidate(baseline.manifest, changes, includedChangeKeys, versions)
  const contentHash = canonicalHash(candidate)
  const preview = set.preview as Preview | undefined
  if (preview?.status !== 'ready' || preview.revision !== expectedRevision || preview.changeHash !== expectedChangeHash || preview.contentHash !== contentHash || preview.contentHash !== previewContentHash || preview.baselineSnapshotID !== baseline.snapshotID || preview.baselineSequence !== baseline.sequence || !Array.isArray(preview.includedChangeKeys) || !keysEqual(preview.includedChangeKeys, includedChangeKeys)) throw new Error('A ready private preview for this exact candidate with its exact baseline is required before approval.')
  if (!exactQualityProof(set.quality, { revision: expectedRevision, changeHash: expectedChangeHash, contentHash, includedChangeKeys, baselineSnapshotID: baseline.snapshotID, baselineSequence: baseline.sequence, previewJobID: input.previewJobID })) throw new Error('A passing deterministic quality proof for this exact candidate is required before approval.')
  const excluded = changes.filter((change) => !includedChangeKeys.includes(`${change.collection}:${change.id}`))
  if (excluded.length) await payload.create({ collection: 'change-sets', data: { name: `${String(set.name)} — remaining changes`, actor: idOf(set.actor), state: 'open', revision: 0, changes: excluded }, overrideAccess: true, req, context: { editorialInternal: true } })
  const snapshotDoc = await payload.create({ collection: 'publish-snapshots', data: { contentHash, changeSet: id, reviewRevision: expectedRevision, changeHash: expectedChangeHash, manifest: candidate, themeVersion: versions.themeVersion, engineVersion: versions.engineVersion, contractVersion: versions.contractVersion, approvedBy: reviewer.id, baselineSnapshot: baseline.snapshotID, baselineSequence: baseline.sequence }, overrideAccess: true, req, context: { editorialInternal: true } })
  const scheduled = scheduledFor ? await payload.create({ collection: 'scheduled-publications', data: { idempotencyKey, snapshot: snapshotDoc.id, changeSet: id, scheduledFor, state: 'scheduled', proof: { ...(structuredClone((set.quality as { proof?: Record<string, unknown> } | undefined)?.proof ?? {})), idempotencyKey, reviewRevision: expectedRevision, changeHash: expectedChangeHash, includedChangeKeys, previewContentHash, approvedBy: reviewer.id } }, overrideAccess: true, req, context: { editorialInternal: true } }) : undefined
  const outbox = scheduled ? undefined : await payload.create({ collection: 'publish-outbox', data: { idempotencyKey, sequence: await nextOutboxSequence(payload, req), snapshot: snapshotDoc.id, changeSet: id, reviewRevision: expectedRevision, changeHash: expectedChangeHash, includedChangeKeys, status: 'pending', attempts: 0, correlationID: randomUUID() }, overrideAccess: true, req, context: { editorialInternal: true } })
  await payload.update({ collection: 'change-sets', id, data: { state: 'approved', changes: changes.filter((change) => includedChangeKeys.includes(`${change.collection}:${change.id}`)), reviewedAt: new Date().toISOString() }, overrideAccess: true, req, context: { editorialInternal: true } })
  await payload.create({ collection: 'audit-events', data: { event: 'editorial.change_set_approved', user: reviewer.id, actor: reviewer.id, detail: { changeSet: id, snapshot: snapshotDoc.id, outbox: outbox?.id, scheduledPublication: scheduled?.id, scheduledFor, includedChangeKeys } }, overrideAccess: true, req })
  return { snapshotID: snapshotDoc.id, outboxID: outbox?.id, scheduledPublicationID: scheduled?.id, idempotencyKey, scheduledFor }
}

type ScheduledPublication = { id: string; idempotencyKey: string; state?: string; scheduledFor?: string; snapshot?: unknown; outbox?: unknown; proof?: { includedChangeKeys?: unknown } }

async function skipScheduledPublication(payload: Payload, req: PayloadRequest, schedule: ScheduledPublication, reason: string) {
  const updated = await payload.update({ collection: 'scheduled-publications', where: { and: [{ id: { equals: schedule.id } }, { state: { equals: 'scheduled' } }] }, data: { state: 'stale', dispatchReason: reason }, overrideAccess: true, req, context: { editorialInternal: true } })
  if (!updated.docs[0]) return false
  const snapshot = schedule.snapshot as Record<string, unknown> | undefined
  const changeSetID = idOf(snapshot?.changeSet)
  if (changeSetID) {
    const set = await payload.findByID({ collection: 'change-sets', id: changeSetID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>
    if (set.state === 'approved') await payload.update({ collection: 'change-sets', id: changeSetID, data: { state: 'changes-requested', revision: Number(set.revision ?? 0) + 1, quality: undefined, preview: undefined, reviewedAt: new Date().toISOString() }, overrideAccess: true, req, context: { editorialInternal: true } })
  }
  await payload.create({ collection: 'audit-events', data: { event: 'editorial.scheduled_publication_skipped', detail: { scheduledPublication: schedule.id, reason, changeSet: changeSetID, reopenedForReview: Boolean(changeSetID) } }, overrideAccess: true, req })
  return true
}

/** Dispatches due schedules only when the frozen approval baseline remains the queue head. */
export async function dispatchDueScheduledPublications(payload: Payload, req: PayloadRequest, now = new Date()) {
  requireTransaction(req, 'Scheduled publication dispatch')
  const due = await payload.find({ collection: 'scheduled-publications', where: { and: [{ state: { equals: 'scheduled' } }, { scheduledFor: { less_than_equal: now.toISOString() } }] }, sort: 'scheduledFor', limit: 100, depth: 2, overrideAccess: true, req })
  let enqueued = 0; let skipped = 0
  for (const schedule of due.docs as unknown as ScheduledPublication[]) {
    const snapshot = schedule.snapshot as Record<string, unknown> | undefined
    const approvedBy = snapshot && typeof snapshot === 'object' ? snapshot.approvedBy : undefined
    const approver = approvedBy && typeof approvedBy === 'object' ? approvedBy as Actor : undefined
    if (!snapshot || !hasRole(approver, ['owner', 'approver'])) {
      if (await skipScheduledPublication(payload, req, schedule, 'APPROVAL_AUTHORITY_REVOKED')) skipped += 1
      continue
    }
    const frozenSnapshotID = idOf(snapshot.baselineSnapshot)
    const frozenSequence = Number(snapshot.baselineSequence ?? 0)
    const baseline = await approvalBaseline(payload, req)
    if (!baseline || baseline.snapshotID !== frozenSnapshotID || baseline.sequence !== frozenSequence) {
      if (await skipScheduledPublication(payload, req, schedule, 'BASELINE_STALE')) skipped += 1
      continue
    }
    const existing = await payload.find({ collection: 'publish-outbox', where: { idempotencyKey: { equals: schedule.idempotencyKey } }, limit: 1, depth: 0, overrideAccess: true, req })
    const includedChangeKeys = Array.isArray(schedule.proof?.includedChangeKeys) ? schedule.proof.includedChangeKeys : []
    const outbox = existing.docs[0] ?? await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: schedule.idempotencyKey, sequence: await nextOutboxSequence(payload, req), snapshot: snapshot.id as string, changeSet: idOf(snapshot.changeSet)!, reviewRevision: Number(snapshot.reviewRevision), changeHash: String(snapshot.changeHash), includedChangeKeys, status: 'pending', attempts: 0, correlationID: randomUUID() }, overrideAccess: true, req, context: { editorialInternal: true } })
    const updated = await payload.update({ collection: 'scheduled-publications', where: { and: [{ id: { equals: schedule.id } }, { state: { equals: 'scheduled' } }] }, data: { state: 'enqueued', outbox: outbox.id, enqueuedAt: now.toISOString(), dispatchReason: null }, overrideAccess: true, req, context: { editorialInternal: true } })
    if (!updated.docs[0]) throw new Error('The scheduled publication is no longer current.')
    await payload.create({ collection: 'audit-events', data: { event: 'editorial.scheduled_publication_enqueued', detail: { scheduledPublication: schedule.id, outbox: outbox.id, sequence: outbox.sequence } }, overrideAccess: true, req })
    enqueued += 1
  }
  return { enqueued, skipped }
}

export async function cancelScheduledPublication(input: { payload: Payload; req: PayloadRequest; actor: Actor | undefined; id: string }) {
  const { payload, req, actor, id } = input; requireTransaction(req, 'Scheduled publication cancellation')
  const owner = await canonicalOwner(payload, req, actor)
  const schedule = await payload.findByID({ collection: 'scheduled-publications', id, depth: 0, overrideAccess: true, req }) as unknown as { changeSet?: unknown }
  const updated = await payload.update({ collection: 'scheduled-publications', where: { and: [{ id: { equals: id } }, { state: { equals: 'scheduled' } }] }, data: { state: 'cancelled', dispatchReason: 'CANCELLED_BY_OWNER' }, overrideAccess: true, req, context: { editorialInternal: true } })
  if (!updated.docs[0]) throw new Error('Only a scheduled publication can be cancelled.')
  const changeSetID = idOf(schedule.changeSet)
  if (changeSetID) {
    const set = await payload.findByID({ collection: 'change-sets', id: changeSetID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>
    if (set.state === 'approved') await payload.update({ collection: 'change-sets', id: changeSetID, data: { state: 'changes-requested', revision: Number(set.revision ?? 0) + 1, quality: undefined, preview: undefined, reviewedAt: new Date().toISOString() }, overrideAccess: true, req, context: { editorialInternal: true } })
  }
  await payload.create({ collection: 'audit-events', data: { event: 'editorial.scheduled_publication_cancelled', user: owner.id, actor: owner.id, detail: { scheduledPublication: id, changeSet: changeSetID, reopenedForReview: Boolean(changeSetID) } }, overrideAccess: true, req })
  return updated.docs[0]
}

export async function reschedulePublication(input: { payload: Payload; req: PayloadRequest; actor: Actor | undefined; id: string; scheduledFor: unknown }) {
  const { payload, req, actor, id } = input; requireTransaction(req, 'Scheduled publication rescheduling')
  const owner = await canonicalOwner(payload, req, actor); const scheduledFor = scheduledPublicationTime(input.scheduledFor)
  if (!scheduledFor) throw new Error('scheduledFor is required.')
  const updated = await payload.update({ collection: 'scheduled-publications', where: { and: [{ id: { equals: id } }, { state: { equals: 'scheduled' } }] }, data: { scheduledFor, dispatchReason: null }, overrideAccess: true, req, context: { editorialInternal: true } })
  if (!updated.docs[0]) throw new Error('Only a scheduled publication can be rescheduled.')
  await payload.create({ collection: 'audit-events', data: { event: 'editorial.scheduled_publication_rescheduled', user: owner.id, actor: owner.id, detail: { scheduledPublication: id, scheduledFor } }, overrideAccess: true, req })
  return updated.docs[0]
}

/** Claims only the oldest unfinished job. A backoff or live lease deliberately blocks later jobs. */
export async function claimNextPublishJob(payload: Payload, req: PayloadRequest, now = new Date(), leaseMilliseconds = 60_000, maxAttempts = MAX_PUBLISH_ATTEMPTS) {
  requireTransaction(req, 'Publish claim')
  await dispatchDueScheduledPublications(payload, req, now)
  const result = await payload.find({ collection: 'publish-outbox', where: { status: { in: ['pending', 'processing'] } }, sort: 'sequence', limit: 1, depth: 0, overrideAccess: true, req })
  const job = result.docs[0]
  if (!job) return null
  const due = !job.nextAttemptAt || new Date(String(job.nextAttemptAt)).getTime() <= now.getTime()
  const expired = job.status === 'processing' && job.leaseExpiresAt && new Date(String(job.leaseExpiresAt)).getTime() <= now.getTime()
  if ((job.status === 'pending' && !due) || (job.status === 'processing' && !expired)) return null
  if (job.status === 'processing' && expired && Number(job.attempts ?? 0) >= maxAttempts) {
    const failed = await payload.update({ collection: 'publish-outbox', where: { and: [{ id: { equals: job.id } }, { status: { equals: 'processing' } }, { leaseExpiresAt: { less_than_equal: now.toISOString() } }] }, data: { status: 'failed', errorCode: 'LEASE_EXPIRED', lastError: 'LEASE_EXPIRED', leaseToken: null, leaseExpiresAt: null }, overrideAccess: true, req, context: { editorialInternal: true } })
    if (!failed.docs[0]) throw new Error('The publish lease is no longer current.')
    return null
  }
  const leaseToken = randomUUID()
  const claimed = await payload.update({ collection: 'publish-outbox', where: { and: [{ id: { equals: job.id } }, { status: { equals: job.status } }, ...(job.status === 'processing' ? [{ leaseExpiresAt: { less_than_equal: now.toISOString() } }] : [])] }, data: { status: 'processing', claimedAt: now.toISOString(), leaseToken, leaseExpiresAt: new Date(now.getTime() + leaseMilliseconds).toISOString(), attempts: Number(job.attempts ?? 0) + 1 }, overrideAccess: true, req, context: { editorialInternal: true } })
  return claimed.docs[0] ?? null
}

/** Moves a current lease to bounded exponential backoff without retaining raw failure text. */
export async function retryPublishJob(payload: Payload, req: PayloadRequest, id: string, leaseToken: string, errorCode: string, now = new Date(), maxAttempts = 3) {
  requireTransaction(req, 'Publish retry')
  const job = await payload.findByID({ collection: 'publish-outbox', id, depth: 0, overrideAccess: true, req })
  if (job.status !== 'processing' || job.leaseToken !== leaseToken || !job.leaseExpiresAt || new Date(String(job.leaseExpiresAt)).getTime() <= now.getTime()) throw new Error('The publish lease is no longer current.')
  const terminal = Number(job.attempts) >= maxAttempts
  const nextAttemptAt = terminal ? undefined : new Date(now.getTime() + 1_000 * 2 ** Math.max(0, Number(job.attempts) - 1)).toISOString()
  const updated = await payload.update({ collection: 'publish-outbox', where: { and: [{ id: { equals: id } }, { status: { equals: 'processing' } }, { leaseToken: { equals: leaseToken } }] }, data: { status: terminal ? 'failed' : 'pending', errorCode: cleanErrorCode(errorCode), lastError: cleanErrorCode(errorCode), nextAttemptAt, leaseToken: null, leaseExpiresAt: null }, overrideAccess: true, req, context: { editorialInternal: true } })
  if (!updated.docs[0]) throw new Error('The publish lease is no longer current.')
  return updated.docs[0]
}

/** Extends an active lease while slow build or delivery work runs outside the transaction. */
export async function renewPublishLease(payload: Payload, req: PayloadRequest, id: string, leaseToken: string, now = new Date(), leaseMilliseconds = 60_000) {
  requireTransaction(req, 'Publish lease renewal')
  const updated = await payload.update({ collection: 'publish-outbox', where: { and: [{ id: { equals: id } }, { status: { equals: 'processing' } }, { leaseToken: { equals: leaseToken } }, { leaseExpiresAt: { greater_than: now.toISOString() } }] }, data: { leaseExpiresAt: new Date(now.getTime() + leaseMilliseconds).toISOString() }, overrideAccess: true, req, context: { editorialInternal: true } })
  if (!updated.docs[0]) throw new Error('The publish lease is no longer current.')
  return updated.docs[0]
}

function verifyArtifact(snapshot: Record<string, unknown>, artifact: VerifiedArtifact) {
  const names = artifact.checks.map((check) => check.name)
  if (!/^[a-f0-9]{64}$/i.test(artifact.digest) || names.length !== REQUIRED_PUBLISH_HEALTH_CHECKS.length || new Set(names).size !== names.length || REQUIRED_PUBLISH_HEALTH_CHECKS.some((name) => !names.includes(name)) || artifact.checks.some((check) => check.status !== 'passed') || artifact.sourceContentHash !== snapshot.contentHash || artifact.themeVersion !== snapshot.themeVersion || artifact.engineVersion !== snapshot.engineVersion || artifact.contractVersion !== snapshot.contractVersion) throw new Error('Verified artifact identity does not match the immutable snapshot.')
}

/** Activates only a verified artifact from the current lease; delivery itself remains outside this transaction. */
export async function completePublishJob(payload: Payload, req: PayloadRequest, id: string, leaseToken: string, artifact: VerifiedArtifact, now = new Date()) {
  requireTransaction(req, 'Publish completion')
  const job = await payload.findByID({ collection: 'publish-outbox', id, depth: 1, overrideAccess: true, req })
  const existing = await payload.find({ collection: 'published-releases', where: { outbox: { equals: id } }, limit: 1, depth: 0, overrideAccess: true, req })
  if (existing.docs[0]) {
    if (canonicalHash(existing.docs[0].artifact) !== canonicalHash(artifact)) throw new Error('Completion does not match the persisted artifact.')
    return existing.docs[0]
  }
  const snapshot = job.snapshot
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Publish job is missing its immutable snapshot.')
  verifyArtifact(snapshot as unknown as Record<string, unknown>, artifact)
  if (job.status !== 'processing' || job.leaseToken !== leaseToken || !job.leaseExpiresAt || new Date(String(job.leaseExpiresAt)).getTime() <= now.getTime()) throw new Error('The publish lease is no longer current.')
  const oldestUnfinished = await payload.find({ collection: 'publish-outbox', where: { status: { in: ['pending', 'processing'] } }, sort: 'sequence', limit: 1, depth: 0, overrideAccess: true, req })
  if (oldestUnfinished.docs[0]?.id !== id) throw new Error('Only the oldest unfinished publish job can complete.')
  const latest = await payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 0, overrideAccess: true, req })
  if (latest.docs[0] && Number(latest.docs[0].sequence) >= Number(job.sequence)) throw new Error('An out-of-order publish job cannot activate an older release.')
  const snapshotID = idOf(snapshot)
  if (!snapshotID) throw new Error('Publish job is missing its immutable snapshot.')
  const release = await payload.create({ collection: 'published-releases', data: { outbox: id, sequence: Number(job.sequence), snapshot: snapshotID, activatedAt: now.toISOString(), healthEvidence: { checks: artifact.checks }, artifact }, overrideAccess: true, req, context: { editorialInternal: true } })
  const updated = await payload.update({ collection: 'publish-outbox', where: { and: [{ id: { equals: id } }, { status: { equals: 'processing' } }, { leaseToken: { equals: leaseToken } }] }, data: { status: 'completed', completedAt: now.toISOString(), completionEvidence: artifact, leaseToken: null, leaseExpiresAt: null }, overrideAccess: true, req, context: { editorialInternal: true } })
  if (!updated.docs[0]) throw new Error('The publish lease is no longer current.')
  const changeSetID = idOf(job.changeSet)
  if (!changeSetID) throw new Error('Publish job is missing its change set.')
  await payload.update({ collection: 'change-sets', id: changeSetID, data: { state: 'published' }, overrideAccess: true, req, context: { editorialInternal: true } })
  return release
}

/** Shared-secret guard for private publish workers; browser sessions never authorize it. */
export function publishWorkerAuthorized(request: Request): boolean {
  const secret = process.env.PUBLISH_WORKER_TOKEN
  const authorization = request.headers.get('authorization')
  if (!secret || Buffer.byteLength(secret) < 32 || !authorization?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(authorization.slice('Bearer '.length)); const expected = Buffer.from(secret)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export async function boundedPublishWorkerJSON(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {}
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_PUBLISH_WORKER_BODY_BYTES) { await reader.cancel(); throw new Error('Request body too large.') } chunks.push(part.value) } } finally { reader.releaseLock() }
  const value = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be an object.')
  return value as Record<string, unknown>
}
