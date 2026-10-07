import { createHash, randomUUID } from 'node:crypto'
import type { Payload, PayloadRequest } from 'payload'
import { MediaReferenceSchema, PageSchema, RedirectSchema, SectionSchema, SiteSettingsDraftSchema, StyleGuideSchema, ThemeSelectionSchema } from '@site-engine/contract'
import { checkSiteSnapshot, type QualityReport } from '@site-engine/checks'
import { hasRole } from './access'
import { mediaFileIdentity, snapshotMediaReference } from './media'
import { validatePageTree, type TreePage, type TreeSection } from './tree/validation'
import { enqueueNotification } from './notification-settings'

export type CapturedCollection = 'pages' | 'sections' | 'redirects' | 'assets' | 'theme-settings' | 'site-settings' | 'style-guides'
export type ChangeSetState = 'open' | 'submitted' | 'changes-requested' | 'approved' | 'rejected' | 'published' | 'discarded' | 'stale'

type Actor = { id: string; roles?: ('owner' | 'approver' | 'editor' | 'sales' | 'hiring')[] | null; disabled?: boolean | null }
export type CapturedChange = {
  collection: CapturedCollection
  id: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  beforeHash: string | null
  afterHash: string | null
  /** A reviewable public removal retains its draft and bytes until retention. */
  retainedDraftHash?: string
}

const mutableFields: Record<CapturedCollection, readonly string[]> = {
  pages: ['title', 'slug', 'sectionId', 'parentId', 'summary', 'template', 'status', 'blocks', 'kicker', 'lede', 'seoDescription', 'noindex', 'publishedAt', 'lastReviewed', 'jobPosting', 'businessCase'],
  sections: ['name', 'summary', 'slug', 'landingPageId', 'allowedTemplates', 'pageIds'],
  redirects: ['from', 'to', 'status'],
  assets: ['filename', 'mimeType', 'width', 'height', 'alt', 'decorative', 'focalX', 'focalY', 'sizes'],
  'theme-settings': ['selection', 'settings'],
  'style-guides': ['bannedPhrases', 'preferredTerms', 'canadianSpelling', 'maximumSentenceWords', 'minimumReadingEase'],
  'site-settings': ['siteName', 'legalName', 'homepageId', 'defaultLocale', 'organizationType', 'logo', 'logos', 'contactEmail', 'contactPhone', 'address', 'linkedIn', 'incident', 'navigation', 'seoDescription', 'searchEnabled', 'crawlerPolicy'],
}

function idOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') return value.id
  return undefined
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: Record<string, unknown> | null): string | null {
  return value === null ? null : createHash('sha256').update(stable(value)).digest('hex')
}

/** Payload returns null for an omitted optional text field. Review snapshots
 * omit it too, except where null is the deliberate clear of a prior value. */
function normalizePageOptionalNulls(value: Record<string, unknown> | null, prior?: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return value
  const normalized = { ...value }
  for (const field of ['kicker', 'lede', 'seoDescription', 'publishedAt', 'lastReviewed', 'jobPosting', 'businessCase']) {
    if (normalized[field] === null && !(prior && field in prior)) delete normalized[field]
  }
  return normalized
}

function normalizeSiteOptionalNulls(value: Record<string, unknown> | null, prior?: Record<string, unknown> | null): Record<string, unknown> | null {
  return value ? Object.fromEntries(Object.entries(value).filter(([field, item]) => item !== null || Boolean(prior && field in prior))) : value
}

export function snapshot(collection: CapturedCollection, document: Record<string, unknown> | undefined, includeFocalPoint = false): Record<string, unknown> | null {
  if (!document) return null
  if (collection === 'assets') return { ...snapshotMediaReference(document as Parameters<typeof snapshotMediaReference>[0], includeFocalPoint), caption: typeof document.caption === 'string' ? document.caption : null, credit: typeof document.credit === 'string' ? document.credit : null, tags: Array.isArray(document.tags) ? document.tags.filter((tag): tag is string => typeof tag === 'string') : [] }
  return Object.fromEntries(mutableFields[collection].flatMap((field): [string, unknown][] => {
    const value = document[field]
    if (field === 'blocks') return [[field, Array.isArray(value) ? value : []]]
    // Payload materializes an omitted optional section summary as null while
    // the portable snapshot contract represents omission.
    if (collection === 'sections' && field === 'summary' && value === null) return []
    // Draft records are the editor's working copy of published content. They
    // must compare to the published snapshot as published, while an explicit
    // archival operation remains visible to the approval candidate.
    if (collection === 'pages' && field === 'status') return [[field, value === 'archived' ? 'archived' : 'published']]
    if (value === undefined) return []
    // Payload populates relationship fields at hook depth. Captures are the
    // portable review representation, so retain their immutable identifiers.
    if (field === 'homepageId') return [[field, idOf(value) ?? null]]
    if (field === 'logo') return [[field, idOf(value) ?? null]]
    if (collection === 'site-settings' && field === 'logos' && value && typeof value === 'object') {
      const logos: Array<[string, string]> = []
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const assetID = idOf(item)
        if (assetID) logos.push([key, assetID])
      }
      return logos.length ? [[field, Object.fromEntries(logos)]] : []
    }
    if (collection === 'site-settings' && field === 'address' && value && typeof value === 'object') {
      const address = value as Record<string, unknown>
      return ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode'].every(key => typeof address[key] === 'string' && address[key]) ? [[field, value]] : [[field, null]]
    }
    if (collection === 'site-settings' && field === 'incident' && value && typeof value === 'object') {
      const incident = value as Record<string, unknown>
      return typeof incident.label === 'string' && incident.label && typeof incident.guidance === 'string' && incident.guidance ? [[field, value]] : [[field, null]]
    }
    if (field === 'sectionId') return [[field, idOf(value) ?? null]]
    if (field === 'parentId') {
      const parentID = idOf(value)
      return parentID ? [[field, parentID]] : []
    }
    if (field === 'landingPageId') {
      const landingID = idOf(value)
      return landingID ? [[field, landingID]] : []
    }
    if (field === 'pageIds') return [[field, Array.isArray(value) ? value.map((item) => idOf(item) ?? item) : []]]
    return [[field, value]]
  }))
}

/** The generated edit timestamp is publication metadata, never a draft input.
 * It is attached only after content comparison so a reverted edit remains a
 * no-op and restoration/proposed deltas never write Payload-managed fields. */
function withCapturedPageTimestamp(value: Record<string, unknown> | null, document: Record<string, unknown>): Record<string, unknown> | null {
  return value && typeof document.updatedAt === 'string' ? { ...value, updatedAt: document.updatedAt } : value
}

export function restoration(collection: CapturedCollection, value: Record<string, unknown>): Record<string, unknown> {
  // Payload applies partial updates. Explicit nulls clear fields that were absent
  // from the baseline rather than leaving a later editor's addition behind.
  // Asset bytes and generated variants are immutable. A discard restores only
  // the editable public metadata represented by the capture; sending null for
  // generated `sizes` corrupts Payload's upload-field validation.
  const fields = collection === 'assets'
    ? ['alt', 'decorative', ...(capturedAssetHasFocalPoint(value) ? ['focalX', 'focalY'] : [])]
    : mutableFields[collection]
  return Object.fromEntries(fields.map((field) => {
    // Draft persistence cannot accept the snapshot-only published status.
    // Restoring an archived draft returns it to the ordinary draft workflow.
    if (collection === 'pages' && field === 'status') return [field, 'draft']
    if (collection === 'pages' && field === 'noindex' && !(field in value)) return [field, false]
    // Payload group traversal requires an object even when every nested value
    // is being cleared. The collection hook normalizes these empty groups.
    if (collection === 'site-settings' && field === 'logos' && !(field in value)) return [field, { primaryLight: null, primaryDark: null, fullLockupLight: null, fullLockupDark: null, symbolLight: null, symbolDark: null }]
    if (collection === 'site-settings' && field === 'address' && !(field in value)) return [field, { streetAddress: null, addressLocality: null, addressRegion: null, postalCode: null, addressCountry: null }]
    if (collection === 'site-settings' && field === 'incident' && !(field in value)) return [field, { label: null, guidance: null }]
    if (collection === 'site-settings' && field === 'searchEnabled' && !(field in value)) return [field, false]
    return [field, field in value ? value[field] : null]
  }))
}

/** Media focal points entered the portable contract after existing captured
 * changes were already durable. The capture itself is therefore the source of
 * truth for which projection must be compared and restored. */
function capturedAssetHasFocalPoint(value: Record<string, unknown> | null | undefined): boolean {
  return Boolean(value && (Object.prototype.hasOwnProperty.call(value, 'focalX') || Object.prototype.hasOwnProperty.call(value, 'focalY')))
}

function capturedAssetHasMetadata(value: Record<string, unknown> | null | undefined): boolean {
  return Boolean(value && ['caption', 'credit', 'tags'].some((field) => Object.prototype.hasOwnProperty.call(value, field)))
}

/** CMS-only media metadata is reviewable in captures but never part of a public snapshot. */
export function publicAssetSnapshot(value: Record<string, unknown>): Record<string, unknown> {
  const { caption: _caption, credit: _credit, tags: _tags, ...publicFields } = value
  return publicFields
}

export async function assetRestoration(payload: Payload, req: PayloadRequest, current: Record<string, unknown>, before: Record<string, unknown>): Promise<Record<string, unknown>> {
  const metadata = Object.fromEntries(['alt', 'decorative', 'focalX', 'focalY', ...(capturedAssetHasMetadata(before) ? ['caption', 'credit', 'tags'] : [])].flatMap((field) => before[field] === undefined ? [] : [[field, before[field]]]))
  if (before.filename === current.filename) return { ...metadata, currentFileVersion: null, currentFile: null }
  const versions = await payload.find({
    collection: 'asset-file-versions',
    where: { and: [{ parentAsset: { equals: current.id } }, { filename: { equals: before.filename } }] },
    limit: 1, depth: 0, overrideAccess: true, req,
  })
  const version = versions.docs[0] as unknown as Record<string, unknown> | undefined
  if (!version) throw new Error('Cannot discard because the prior immutable asset file version is unavailable.')
  return { ...metadata, currentFileVersion: String(version.id), currentFile: mediaFileIdentity(version) }
}

function equivalent(left: Record<string, unknown> | null, right: Record<string, unknown> | null): boolean {
  return stable(left) === stable(right)
}

function setIDFromRequest(req: PayloadRequest): string | undefined {
  const candidate = req.headers.get('x-site-engine-change-set')
  return candidate && /^[0-9a-f-]{36}$/i.test(candidate) ? candidate : undefined
}

export async function openSet(payload: Payload, actor: Actor, req: PayloadRequest): Promise<Record<string, unknown>> {
  const requested = setIDFromRequest(req)
  if (requested) {
    const selected = await payload.findByID({ collection: 'change-sets', id: requested, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>
    if (!['open', 'changes-requested'].includes(String(selected.state)) || idOf(selected.actor) !== actor.id) throw new Error('The selected change set is not an editable set owned by this editor.')
    return selected
  }
  const existing = await payload.find({ collection: 'change-sets', where: { and: [{ actor: { equals: actor.id } }, { or: [{ state: { equals: 'open' } }, { state: { equals: 'changes-requested' } }] }] }, limit: 1, depth: 0, overrideAccess: true, req })
  if (existing.docs[0]) return existing.docs[0] as unknown as Record<string, unknown>
  return payload.create({ collection: 'change-sets', data: { id: randomUUID(), name: 'Unsubmitted edits', state: 'open', actor: actor.id, revision: 0, changes: [] }, overrideAccess: true, req, context: { editorialInternal: true } }) as unknown as Promise<Record<string, unknown>>
}

/** Called by collection hooks after a draft write. The hook request is reused so
 * content, change set, and audit event commit or roll back together. */
export async function captureChange(input: { collection: CapturedCollection; doc: Record<string, unknown>; previousDoc?: Record<string, unknown>; operation: 'create' | 'update'; req: PayloadRequest }): Promise<void> {
  const { collection, doc, previousDoc, operation, req } = input
  const actor = req.user as Actor | undefined
  const capturesCollection =
    hasRole(actor, ['owner', 'editor']) ||
    (collection === 'pages' && hasRole(actor, ['approver']))
  if (!actor || !capturesCollection || req.context.editorialInternal) return
  const includeFocalPoint = req.context.mediaFocalContract === '1.4.0'
  let after = snapshot(collection, doc, includeFocalPoint)
  let before = operation === 'create' ? null : snapshot(collection, previousDoc, includeFocalPoint)
  if (collection === 'pages') {
    before = normalizePageOptionalNulls(before)
    after = normalizePageOptionalNulls(after, before)
  }
  // Payload materializes omitted singleton fields as null on both creates and
  // later updates. Normalize the before-image first so a first real value can
  // still merge with the portable snapshot's omission. A null after-image is
  // retained only when the normalized before-image held a real value, keeping
  // an explicit clear distinct from database null materialization.
  if (collection === 'site-settings') {
    before = normalizeSiteOptionalNulls(before)
    after = normalizeSiteOptionalNulls(after, before)
  }
  if (equivalent(before, after)) return
  const changeSet = await openSet(req.payload, actor, req)
  const changes = Array.isArray(changeSet.changes) ? [...changeSet.changes] as CapturedChange[] : []
  const index = changes.findIndex((change) => change.collection === collection && change.id === doc.id)
  const change: CapturedChange = { collection, id: String(doc.id), before, after, beforeHash: hash(before), afterHash: hash(after) }
  if (index >= 0) {
    // Preserve the original baseline while replacing the latest after-image.
    change.before = changes[index].before
    change.beforeHash = changes[index].beforeHash
    if (equivalent(change.before, change.after)) changes.splice(index, 1)
    else {
      if (collection === 'pages') change.after = withCapturedPageTimestamp(change.after, doc)
      change.afterHash = hash(change.after)
      changes[index] = change
    }
  } else {
    if (collection === 'pages') change.after = withCapturedPageTimestamp(change.after, doc)
    change.afterHash = hash(change.after)
    changes.push(change)
  }
  await req.payload.update({ collection: 'change-sets', id: String(changeSet.id), data: { changes, revision: Number(changeSet.revision ?? 0) + 1 }, overrideAccess: true, req, context: { editorialInternal: true } })
  await req.payload.create({ collection: 'audit-events', data: { event: 'editorial.change_captured', user: actor.id, actor: actor.id, detail: { changeSet: changeSet.id, collection, id: doc.id } }, overrideAccess: true, req })
  // Editorial diagnostics guide correction; only the collection's contract and
  // tree hooks above may abort the write.
  ;(doc as Record<string, unknown>).readiness = await currentDraftReadiness(req.payload, req, changes)
}

function assertActor(actor: Actor | undefined): asserts actor is Actor {
  if (!actor || actor.disabled) throw new Error('Authentication is required.')
}

async function loadSet(payload: Payload, id: string, req: PayloadRequest): Promise<Record<string, unknown>> {
  return payload.findByID({ collection: 'change-sets', id, depth: 0, overrideAccess: true, req }) as unknown as Promise<Record<string, unknown>>
}

export function currentChange(collection: CapturedCollection, value: Record<string, unknown> | undefined, expected?: Record<string, unknown> | null): Record<string, unknown> | null {
  let current = snapshot(collection, value, collection === 'assets' && capturedAssetHasFocalPoint(expected))
  if (collection === 'assets' && current && !capturedAssetHasMetadata(expected)) current = publicAssetSnapshot(current)
  if (collection === 'pages') {
    current = normalizePageOptionalNulls(current, expected)
    // Compare the mutable page projection while retaining the trusted capture
    // timestamp for candidate assembly. A generated timestamp alone must not
    // stale, conflict, or prevent discarding a reverted content edit.
    return current && typeof expected?.updatedAt === 'string' ? { ...current, updatedAt: expected.updatedAt } : current
  }
  if (collection === 'site-settings') return normalizeSiteOptionalNulls(current, expected)
  return current
}

export async function markStaleIfNeeded(payload: Payload, set: Record<string, unknown>, req: PayloadRequest): Promise<Record<string, unknown>> {
  if (!['open', 'submitted', 'changes-requested'].includes(String(set.state))) return set
  const baseline = typeof set.reviewedAt === 'string' ? set.reviewedAt : set.createdAt
  const expired = Date.now() - new Date(String(baseline)).getTime() > 30 * 24 * 60 * 60 * 1000
  const changes = Array.isArray(set.changes) ? set.changes as CapturedChange[] : []
  let changed = expired
  if (!expired) for (const change of changes) {
    const expectedHash = change.retainedDraftHash ?? change.afterHash
    if (!expectedHash) continue
    try {
      const found = await payload.find({ collection: change.collection, where: { id: { equals: change.id } }, limit: 1, depth: 0, draft: true, overrideAccess: true, req })
      const doc = found.docs[0] as unknown as Record<string, unknown> | undefined
      if (hash(currentChange(change.collection, doc, change.retainedDraftHash ? change.before : change.after)) !== expectedHash) { changed = true; break }
    } catch { changed = true; break }
  }
  if (!changed) return set
  return payload.update({ collection: 'change-sets', id: String(set.id), data: { state: 'stale', staleAt: new Date().toISOString() }, overrideAccess: true, req, context: { editorialInternal: true } }) as unknown as Promise<Record<string, unknown>>
}

export type ChangeSetQualityCheck = {
  name: string
  status: 'passed' | 'failed'
  errors: Array<{ collection: string; id: string; message: string }>
}

/** Evaluate the identical normalized candidate that preview and publication
 * use: captured changes are applied to the frozen queue/public baseline. */
export async function currentDraftReadiness(payload: Payload, req: PayloadRequest, changes: CapturedChange[], options: { asOf?: Date | string } = {}): Promise<QualityReport> {
  try {
    const [{ currentPreviewBaseline }, { buildCandidate }] = await Promise.all([import('./review-preview'), import('./publishing')])
    const base = await currentPreviewBaseline(payload, req)
    if (!base) throw new Error('No configured baseline')
    const candidate = buildCandidate(base.manifest, changes, changes.map(change => `${change.collection}:${change.id}`), base.versions)
    return checkSiteSnapshot(candidate, { ...(options.asOf ? { asOf: options.asOf } : {}), style: candidate.styleGuide })
  } catch {
    // A stale or malformed capture must remain available for repair. The
    // contract/tree evaluator is the only write-aborting quality gate.
    const unavailable = { code: 'READINESS_CANDIDATE_UNAVAILABLE', severity: 'blocker' as const, path: '$', message: 'Readiness cannot be evaluated until the captured draft can be assembled against its publication baseline.', remediation: 'Correct the draft or refresh the change set, then review readiness again.' }
    return { version: 1, asOf: typeof options.asOf === 'string' ? options.asOf : (options.asOf ?? new Date()).toISOString(), publishable: false, issues: [unavailable], blockers: [unavailable], warnings: [], stalePages: [], ai: { status: 'unavailable', code: 'AI_PROVIDER_UNAVAILABLE', message: 'AI checks are unavailable because no approved provider is configured.' } }
  }
}

export async function changeSetQuality(payload: Payload, req: PayloadRequest, changes: CapturedChange[], options: { asOf?: Date | string } = {}): Promise<{ checks: ChangeSetQualityCheck[]; warnings: string[]; readiness: QualityReport }> {
  const errors: { collection: string; id: string; message: string }[] = []
  for (const change of changes) {
    if (!change.after) continue
    const result = (() => {
      switch (change.collection) {
        case 'pages': return PageSchema.safeParse({ id: change.id, ...normalizePageOptionalNulls(change.after), status: 'draft' })
        case 'sections': return SectionSchema.safeParse({ id: change.id, ...change.after, pageIds: change.after.pageIds ?? [] })
        case 'redirects': return RedirectSchema.safeParse(change.after)
        case 'assets': return MediaReferenceSchema.safeParse({ id: change.id, ...publicAssetSnapshot(change.after) })
        case 'theme-settings': return ThemeSelectionSchema.safeParse(change.after.selection)
        case 'site-settings': return SiteSettingsDraftSchema.safeParse(change.after)
        case 'style-guides': return StyleGuideSchema.safeParse(change.after)
      }
    })()
    if (!result.success) errors.push(...result.error.issues.map((issue) => ({ collection: change.collection, id: change.id, message: `${issue.path.join('.')}: ${issue.message}` })))
    if (change.collection === 'pages' && change.after) {
      const page = { id: change.id, ...change.after } as TreePage
      const [pages, section] = await Promise.all([
        payload.find({ collection: 'pages', limit: 0, pagination: false, depth: 0, draft: true, overrideAccess: true, req }),
        typeof change.after.sectionId === 'string'
          ? payload.find({ collection: 'sections', where: { id: { equals: change.after.sectionId } }, limit: 1, depth: 0, draft: true, overrideAccess: true, req }).then(found => found.docs[0])
          : Promise.resolve(undefined),
      ])
      const treeErrors = validatePageTree(page, pages.docs.map((doc) => ({
        id: doc.id, sectionId: idOf(doc.sectionId) ?? '', parentId: idOf(doc.parentId), slug: doc.slug, template: doc.template, blocks: doc.blocks ?? [], title: doc.title,
      }) as TreePage), section ? { id: section.id, allowedTemplates: section.allowedTemplates ?? [] } as TreeSection : undefined)
      errors.push(...treeErrors.map((issue) => ({ collection: change.collection, id: change.id, message: `${issue.field}: ${issue.message}` })))
    }
  }
  const readiness = await currentDraftReadiness(payload, req, changes, options)
  return { checks: [{ name: 'contract-and-tree', status: errors.length ? 'failed' : 'passed', errors }], warnings: readiness.warnings.map(issue => `${issue.code}: ${issue.message}`), readiness }
}

type DiscardPlan = { change: CapturedChange; current: Record<string, unknown> | undefined }

/** Discard validates every capture before it changes any record. Captures can
 * depend on one another: for example, a page may point at a section created
 * later in the same set. Unwinding such a set one record at a time changes the
 * later record's hash before its conflict guard has run. */
function discardDeleteOrder(plans: DiscardPlan[]): DiscardPlan[] {
  const createdPages = new Map(plans
    .filter((plan) => plan.change.collection === 'pages')
    .map((plan) => [plan.change.id, plan]))
  const pageDepth = (plan: DiscardPlan, seen = new Set<string>()): number => {
    const parentID = idOf(plan.current?.parentId)
    if (!parentID || seen.has(parentID)) return 0
    const parent = createdPages.get(parentID)
    return parent ? 1 + pageDepth(parent, new Set([...seen, parentID])) : 0
  }
  const rank = (plan: DiscardPlan): number => {
    // Clear singleton references before targets, then page leaves before their
    // sections and assets.
    if (plan.change.collection === 'site-settings') return 0
    if (plan.change.collection === 'pages') return 1
    if (plan.change.collection === 'sections') return 2
    if (plan.change.collection === 'assets') return 3
    return 1
  }
  return [...plans].sort((left, right) => {
    const byRank = rank(left) - rank(right)
    if (byRank) return byRank
    if (left.change.collection === 'pages' && right.change.collection === 'pages') return pageDepth(right) - pageDepth(left)
    return 0
  })
}

async function discardChange(payload: Payload, req: PayloadRequest, plan: DiscardPlan): Promise<void> {
  const { change, current } = plan
  if (change.before === null) {
    await payload.delete({ collection: change.collection, id: change.id, overrideAccess: true, req, context: { editorialInternal: true } })
    return
  }
  const data = change.collection === 'assets' && current
    ? await assetRestoration(payload, req, current, change.before)
    : restoration(change.collection, change.before)
  const archivedPage = change.collection === 'pages' && change.before.status === 'archived'
  if (archivedPage) data.status = 'archived'
  await payload.update({ collection: change.collection, id: change.id, data, draft: true, overrideAccess: true, req, context: { editorialInternal: true, ...(archivedPage ? { archiveInternal: true } : {}), ...(change.collection === 'assets' ? { mediaReplacement: true } : {}) } })
}

async function assertDiscardDeleteIsolation(payload: Payload, req: PayloadRequest, plans: DiscardPlan[]): Promise<void> {
  const removed = (collection: CapturedCollection) => new Set(plans.filter((plan) => !plan.change.retainedDraftHash && plan.change.before === null && plan.change.collection === collection).map((plan) => plan.change.id))
  const removedPages = removed('pages')
  const removedSections = removed('sections')
  if (!removedPages.size && !removedSections.size) return
  const [pages, sections] = await Promise.all([
    payload.find({ collection: 'pages', limit: 0, pagination: false, depth: 0, draft: true, overrideAccess: true, req }),
    payload.find({ collection: 'sections', limit: 0, pagination: false, depth: 0, draft: true, overrideAccess: true, req }),
  ])
  const planFor = new Map(plans.map((plan) => [`${plan.change.collection}:${plan.change.id}`, plan]))
  const survives = (collection: CapturedCollection, record: Record<string, unknown>) => {
    const plan = planFor.get(`${collection}:${record.id}`)
    if (!plan) return record
    if (!plan.change.retainedDraftHash && plan.change.before === null) return undefined
    return plan.change.retainedDraftHash ? record : plan.change.before ?? record
  }
  const dependentPage = pages.docs.find((page) => {
    const effective = survives('pages', page as unknown as Record<string, unknown>)
    return effective && (removedPages.has(idOf(effective.parentId) ?? '') || removedSections.has(idOf(effective.sectionId) ?? ''))
  })
  if (dependentPage) throw new Error('Cannot discard because a surviving page depends on a record that would be removed.')
  const dependentSection = sections.docs.find((section) => {
    const effective = survives('sections', section as unknown as Record<string, unknown>)
    if (!effective) return false
    if (removedPages.has(idOf(effective.landingPageId) ?? '')) return true
    return Array.isArray(effective.pageIds) && effective.pageIds.some((id) => removedPages.has(idOf(id) ?? ''))
  })
  if (dependentSection) throw new Error('Cannot discard because a surviving section depends on a page that would be removed.')
}

export async function transitionChangeSet(input: { payload: Payload; req: PayloadRequest; actor: Actor | undefined; id: string; action: 'submit' | 'request-changes' | 'reject' | 'discard' | 'refresh' }): Promise<Record<string, unknown>> {
  const { payload, req, id, action } = input; assertActor(input.actor)
  let set = await loadSet(payload, id, req)
  const owns = idOf(set.actor) === input.actor.id
  const reviewer = hasRole(input.actor, ['owner', 'approver'])
  if ((action === 'submit' || action === 'discard' || action === 'refresh') && !owns) throw new Error('Only the editor who owns this change set can perform this action.')
  if ((action === 'request-changes' || action === 'reject') && !reviewer) throw new Error('Reviewer role required.')
  set = await markStaleIfNeeded(payload, set, req)
  if (set.state === 'stale' && action !== 'refresh') throw new Error('This change set is stale. Refresh it before review.')
  const expected: Record<typeof action, ChangeSetState[]> = { submit: ['open', 'changes-requested'], 'request-changes': ['submitted'], reject: ['submitted'], discard: ['open', 'changes-requested', 'rejected'], refresh: ['open', 'changes-requested', 'stale'] }
  if (!expected[action].includes(set.state as ChangeSetState)) throw new Error(`Cannot ${action} a ${String(set.state)} change set.`)
  const changes = Array.isArray(set.changes) ? set.changes as CapturedChange[] : []
  if (action === 'submit' && changes.length === 0) throw new Error('Add at least one draft change before submitting.')
  if (action === 'discard') {
    const current = new Map<string, Record<string, unknown> | undefined>()
    for (const change of changes) {
      const record = (await payload.find({ collection: change.collection, where: { id: { equals: change.id } }, limit: 1, depth: 0, draft: true, overrideAccess: true, req })).docs[0] as unknown as Record<string, unknown> | undefined
      current.set(`${change.collection}:${change.id}`, record)
    }
    const plans: DiscardPlan[] = changes.map((change) => ({ change, current: current.get(`${change.collection}:${change.id}`) }))
    for (const { change, current: record } of plans) {
      if (hash(currentChange(change.collection, record, change.retainedDraftHash ? change.before : change.after)) !== (change.retainedDraftHash ?? change.afterHash)) throw new Error('Cannot discard because a later draft edit changed this record. Refresh and resolve it first.')
    }
    const mutable = plans.filter((plan) => !plan.change.retainedDraftHash)
    await assertDiscardDeleteIsolation(payload, req, plans)
    // Existing pages leave newly-created sections before the latter are removed.
    for (const plan of mutable.filter((plan) => plan.change.before !== null)) await discardChange(payload, req, plan)
    for (const plan of discardDeleteOrder(mutable.filter((plan) => plan.change.before === null))) await discardChange(payload, req, plan)
  }
  if (action === 'refresh') {
    const rebased: CapturedChange[] = []
    for (const change of changes) {
      let current: Record<string, unknown> | undefined
      current = (await payload.find({ collection: change.collection, where: { id: { equals: change.id } }, limit: 1, depth: 0, draft: true, overrideAccess: true, req })).docs[0] as unknown as Record<string, unknown> | undefined
      const after = currentChange(change.collection, current, change.retainedDraftHash ? change.before : change.after)
      if (hash(after) !== (change.retainedDraftHash ?? change.afterHash)) throw new Error('This change set conflicts with a later draft edit. Resolve the conflict before refreshing.')
      if (change.retainedDraftHash) { rebased.push(change); continue }
      if (!equivalent(change.before, after)) rebased.push(change)
    }
    set = await payload.update({ collection: 'change-sets', id, data: { state: 'open', changes: rebased, staleAt: null, reviewedAt: new Date().toISOString(), revision: Number(set.revision ?? 0) + 1 }, overrideAccess: true, req, context: { editorialInternal: true } }) as unknown as Record<string, unknown>
    await payload.create({ collection: 'audit-events', data: { event: 'editorial.change_set_refresh', user: input.actor.id, actor: input.actor.id, detail: { changeSet: id, rebased: rebased.length } }, overrideAccess: true, req })
    return set
  }
  const details = action === 'submit' ? await changeSetQuality(payload, req, changes) : undefined
  if (details?.checks.some((check) => check.status === 'failed')) throw new Error(`Change-set quality checks failed: ${details.checks.flatMap((check) => check.errors ?? []).map((error) => error.message).join('; ')}`)
  const state: ChangeSetState = action === 'submit' ? 'submitted' : action === 'request-changes' ? 'changes-requested' : action === 'reject' ? 'rejected' : action === 'discard' ? 'discarded' : 'open'
  set = await payload.update({ collection: 'change-sets', id, data: { state, revision: Number(set.revision ?? 0) + 1, quality: details, preview: action === 'submit' ? { status: 'pending' } : undefined, submittedAt: action === 'submit' ? new Date().toISOString() : typeof set.submittedAt === 'string' ? set.submittedAt : undefined, reviewedAt: ['request-changes', 'reject'].includes(action) ? new Date().toISOString() : typeof set.reviewedAt === 'string' ? set.reviewedAt : undefined }, overrideAccess: true, req, context: { editorialInternal: true } }) as unknown as Record<string, unknown>
  if (action === 'submit') await enqueueNotification(payload, req, { kind: 'change-set-submitted', idempotencyKey: `change-set-submitted:${id}:${String(set.revision)}`, sourceType: 'change-set', sourceID: id, payload: { changeSet: id, revision: set.revision } })
  await payload.create({ collection: 'audit-events', data: { event: `editorial.change_set_${action}`, user: input.actor.id, actor: input.actor.id, detail: { changeSet: id, state } }, overrideAccess: true, req })
  return set
}

export async function createNamedChangeSet(payload: Payload, req: PayloadRequest, actor: Actor | undefined, name: string): Promise<Record<string, unknown>> {
  assertActor(actor)
  if (!hasRole(actor, ['owner', 'approver', 'editor'])) throw new Error('Editor role required.')
  return payload.create({ collection: 'change-sets', data: { id: randomUUID(), name, actor: actor.id, state: 'open', revision: 0, changes: [] }, overrideAccess: true, req, context: { editorialInternal: true } }) as unknown as Promise<Record<string, unknown>>
}

export type ChangeConflict = { collection: CapturedCollection; id: string; before: Record<string, unknown> | null; proposed: Record<string, unknown> | null; current: Record<string, unknown> | null; currentHash: string | null; canReapply: boolean }
type ConflictChoice = { collection: CapturedCollection; id: string; currentHash: string | null; choice: 'retain-current' | 'reapply-proposed' }

async function conflictsFor(payload: Payload, req: PayloadRequest, changes: CapturedChange[]): Promise<ChangeConflict[]> {
  const conflicts: ChangeConflict[] = []
  for (const change of changes) {
    let raw: Record<string, unknown> | undefined
    raw = (await payload.find({ collection: change.collection, where: { id: { equals: change.id } }, limit: 1, depth: 0, draft: true, overrideAccess: true, req })).docs[0] as unknown as Record<string, unknown> | undefined
    const current = currentChange(change.collection, raw, change.retainedDraftHash ? change.before : change.after)
    const currentHash = hash(current)
    if (currentHash !== (change.retainedDraftHash ?? change.afterHash)) conflicts.push({ collection: change.collection, id: change.id, before: change.before, proposed: change.after, current, currentHash, canReapply: Boolean(change.before && change.after && raw) })
  }
  return conflicts
}

export async function changeSetConflicts(input: { payload: Payload; req: PayloadRequest; actor: Actor | undefined; id: string }) {
  assertActor(input.actor)
  const set = await loadSet(input.payload, input.id, input.req)
  if (idOf(set.actor) !== input.actor.id) throw new Error('Only the editor who owns this change set can view or resolve conflicts.')
  const current = await markStaleIfNeeded(input.payload, set, input.req)
  if (current.state !== 'stale') return { state: String(current.state), revision: Number(current.revision ?? 0), conflicts: [] as ChangeConflict[] }
  return { state: 'stale', revision: Number(current.revision ?? 0), conflicts: await conflictsFor(input.payload, input.req, Array.isArray(current.changes) ? current.changes as CapturedChange[] : []) }
}

function proposedDelta(collection: CapturedCollection, before: Record<string, unknown>, proposed: Record<string, unknown>) {
  const update: Record<string, unknown> = {}
  for (const field of mutableFields[collection]) {
    if (stable(before[field]) === stable(proposed[field])) continue
    // The stored editor copy is always a draft unless this explicitly archives it.
    if (collection === 'pages' && field === 'status') update[field] = proposed[field] === 'archived' ? 'archived' : 'draft'
    else update[field] = field in proposed ? proposed[field] : null
  }
  return update
}

/** Resolve only the records that changed after capture. Reapplying writes the
 * captured field delta over the hash-guarded current draft; unrelated fields
 * from another editor remain untouched. A subsequent refresh makes a new
 * review candidate and clears all old preview/proof state. */
export async function resolveChangeSetConflicts(input: { payload: Payload; req: PayloadRequest; actor: Actor | undefined; id: string; expectedRevision: number; resolutions: ConflictChoice[] }) {
  const { payload, req, id } = input; assertActor(input.actor)
  let set = await loadSet(payload, id, req)
  if (idOf(set.actor) !== input.actor.id) throw new Error('Only the editor who owns this change set can resolve conflicts.')
  set = await markStaleIfNeeded(payload, set, req)
  if (set.state !== 'stale') throw new Error('Only a stale change set can be resolved.')
  if (Number(set.revision ?? 0) !== input.expectedRevision) throw new Error('This change set changed. Reload the conflict comparison before resolving it.')
  const changes = Array.isArray(set.changes) ? set.changes as CapturedChange[] : []
  const conflicts = await conflictsFor(payload, req, changes)
  if (!conflicts.length) throw new Error('This stale change set has no content conflict. Refresh it instead.')
  const keys = new Set<string>()
  const byKey = new Map<string, ConflictChoice>(input.resolutions.map((resolution) => [`${resolution.collection}:${resolution.id}`, resolution]))
  if (byKey.size !== input.resolutions.length) throw new Error('Each conflicting draft must have exactly one resolution.')
  for (const conflict of conflicts) {
    const key = `${conflict.collection}:${conflict.id}`; keys.add(key)
    const resolution = byKey.get(key)
    if (!resolution || resolution.currentHash !== conflict.currentHash) throw new Error('The draft changed while you were reviewing it. Reload the conflict comparison.')
    if (resolution.choice === 'reapply-proposed' && !conflict.canReapply) throw new Error('This captured create, delete, or unavailable record can only retain the current draft.')
  }
  if ([...byKey.keys()].some((key) => !keys.has(key))) throw new Error('A resolution was supplied for a record that is not currently conflicted.')

  const resolved: CapturedChange[] = []
  let retained = 0; let reapplied = 0
  for (const change of changes) {
    const key = `${change.collection}:${change.id}`
    const conflict = conflicts.find((item) => `${item.collection}:${item.id}` === key)
    if (!conflict) { resolved.push(change); continue }
    const choice = byKey.get(key)!
    if (choice.choice === 'retain-current') { retained++; continue }
    const data = proposedDelta(change.collection, change.before!, change.after!)
    await payload.update({ collection: change.collection, id: change.id, data, draft: true, overrideAccess: false, user: input.actor as never, req, context: { editorialInternal: true, ...(change.collection === 'assets' ? { mediaReplacement: true } : {}) } })
    const saved = await payload.findByID({ collection: change.collection, id: change.id, depth: 0, draft: true, overrideAccess: true, req }) as unknown as Record<string, unknown>
    const after = currentChange(change.collection, saved, change.after)
    resolved.push({ ...change, before: conflict.current, beforeHash: conflict.currentHash, after, afterHash: hash(after) })
    reapplied++
  }
  const next = await payload.update({ collection: 'change-sets', id, data: { changes: resolved, revision: Number(set.revision ?? 0) + 1, preview: null, quality: null }, overrideAccess: true, req, context: { editorialInternal: true } }) as unknown as Record<string, unknown>
  await payload.create({ collection: 'audit-events', data: { event: 'editorial.change_set_conflicts_resolved', user: input.actor.id, actor: input.actor.id, detail: { changeSet: id, retained, reapplied } }, overrideAccess: true, req })
  return next
}
