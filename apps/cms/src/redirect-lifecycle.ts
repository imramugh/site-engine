import { RedirectSchema, SiteSnapshotSchema, type Page, type SiteSnapshot } from '@site-engine/contract'
import { deriveRoutes } from '@site-engine/engine'
import type { Payload, PayloadRequest } from 'payload'
import { captureChange, openSet } from './editorial'

export type RedirectInput = { from: string; to: string; status?: number }
export type ReferenceLocation = { collection: 'pages' | 'navigation'; id: string; field: string }

/** Keep redirect paths in the same canonical form used by public snapshots. */
export function normalizeRedirectPath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Redirect paths must be strings.')
  const trimmed = value.trim()
  const normalized = trimmed !== '/' && trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
  const parsed = RedirectSchema.safeParse({ from: normalized, to: '/', status: 301 })
  if (!parsed.success) throw new Error(`Invalid redirect path: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`)
  return normalized
}

export function normalizedRedirect(input: RedirectInput) {
  const redirect = { from: normalizeRedirectPath(input.from), to: normalizeRedirectPath(input.to), status: 301 as const }
  const parsed = RedirectSchema.safeParse(redirect)
  if (!parsed.success) throw new Error(`Invalid redirect: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`)
  if (redirect.from === redirect.to) throw new Error('A redirect cannot point to itself.')
  return redirect
}

/** Redirects are intentionally one-hop: a target must never be another source. */
export function validateRedirectSet(input: readonly RedirectInput[]): ReturnType<typeof normalizedRedirect>[] {
  const redirects = input.map(normalizedRedirect)
  const seen = new Set<string>()
  for (const redirect of redirects) {
    if (seen.has(redirect.from)) throw new Error(`Redirect source ${redirect.from} is not unique.`)
    seen.add(redirect.from)
  }
  const sources = new Set(redirects.map((redirect) => redirect.from))
  for (const redirect of redirects) {
    if (sources.has(redirect.to)) throw new Error(`Redirect ${redirect.from} points to another redirect (${redirect.to}); redirects must resolve in one hop.`)
  }
  return redirects.sort((left, right) => left.from.localeCompare(right.from))
}

function walk(value: unknown, target: string, field: string, pageID: string, found: ReferenceLocation[]): void {
  if (value === target) found.push({ collection: 'pages', id: pageID, field })
  else if (Array.isArray(value)) value.forEach((item, index) => walk(item, target, `${field}.${index}`, pageID, found))
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => walk(item, target, `${field}.${key}`, pageID, found))
}

/** Finds live ID, navigation, and public-path references that must be removed before archival. */
export function archiveReferences(pageID: string, pages: readonly Pick<Page, 'id' | 'parentId' | 'blocks'>[], baseline?: SiteSnapshot): ReferenceLocation[] {
  const found: ReferenceLocation[] = []
  const oldPath = baseline ? deriveRoutes(baseline).routes.find((route) => route.page.id === pageID)?.path : undefined
  for (const page of pages) {
    if (page.id === pageID) continue
    if (page.parentId === pageID) found.push({ collection: 'pages', id: page.id, field: 'parentId' })
    walk(page.blocks, pageID, 'blocks', page.id, found)
    if (oldPath) walk(page.blocks, oldPath, 'blocks', page.id, found)
  }
  if (baseline?.settings.homepageId === pageID) found.push({ collection: 'navigation', id: 'settings', field: 'homepageId' })
  for (const section of baseline?.settings.sections ?? []) {
    if (section.landingPageId === pageID) found.push({ collection: 'navigation', id: section.id, field: 'landingPageId' })
    for (const [index, referencedID] of section.pageIds.entries()) if (referencedID === pageID) {
      found.push({ collection: 'navigation', id: section.id, field: `pageIds.${index}` })
    }
  }
  return found
}

export function formatArchiveReferences(references: readonly ReferenceLocation[]): string {
  return references.map((reference) => `${reference.collection}:${reference.id}:${reference.field}`).join(', ')
}

export function redirectForPublishedChange(baseline: SiteSnapshot, pageID: string, target?: string) {
  const routes = deriveRoutes(baseline)
  const oldRoute = routes.routes.find((route) => route.page.id === pageID)
  if (!oldRoute) return undefined
  const defaultTarget = oldRoute.page.parentId ? routes.routes.find((route) => route.page.id === oldRoute.page.parentId)?.path : undefined
  const destination = target ? normalizeRedirectPath(target) : defaultTarget
  if (!destination) throw new Error('A redirect target is required when the page has no published parent.')
  return normalizedRedirect({ from: oldRoute.path, to: destination })
}

/** Archives a page in the current change set only after all live references are removed. */
async function queueBaseline(payload: Payload, req: PayloadRequest): Promise<SiteSnapshot | undefined> {
  const queued = await payload.find({ collection: 'publish-outbox', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true, req })
  const queuedManifest = queued.docs[0]?.snapshot && typeof queued.docs[0].snapshot === 'object' ? queued.docs[0].snapshot.manifest : undefined
  if (queuedManifest) return SiteSnapshotSchema.parse(queuedManifest)
  const releases = await payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true, req })
  const manifest = releases.docs[0]?.snapshot && typeof releases.docs[0].snapshot === 'object' ? releases.docs[0].snapshot.manifest : undefined
  return manifest ? SiteSnapshotSchema.parse(manifest) : undefined
}

async function removeLegacyNavigationReference(payload: Payload, req: PayloadRequest, baseline: SiteSnapshot, pageID: string): Promise<string> {
  const actor = req.user as { id?: string; roles?: ('owner' | 'editor')[] } | undefined
  if (!actor?.id) throw new Error('Authentication is required.')
  const section = baseline.settings.sections.find(candidate => candidate.pageIds.includes(pageID))
  if (!section) throw new Error('The published baseline has no navigation reference to remove.')
  if (baseline.settings.homepageId === pageID || section.landingPageId === pageID) throw new Error('Homepage and section landing references must be changed through normal navigation editing.')
  const set = await openSet(payload, actor as never, req)
  const changes = Array.isArray(set.changes) ? set.changes as Array<{ collection: string; id: string }> : []
  if (changes.some(change => change.collection === 'sections' && change.id === section.id)) throw new Error('Resolve the pending section navigation change before archiving this page.')
  const updated = await payload.update({ collection: 'sections', id: section.id, data: { pageIds: section.pageIds.filter(id => id !== pageID) }, draft: true, overrideAccess: true, req, context: { editorialInternal: true } })
  delete (req.context as Record<string, unknown>).editorialInternal
  await captureChange({ collection: 'sections', doc: updated as unknown as Record<string, unknown>, previousDoc: section as unknown as Record<string, unknown>, operation: 'update', req })
  delete (req.context as Record<string, unknown>).editorialInternal
  return section.id
}

export async function archivePage(input: { payload: Payload; req: PayloadRequest; pageID: string; target?: string; baseline?: SiteSnapshot; removeNavigationReference?: boolean }): Promise<{ redirect?: ReturnType<typeof normalizedRedirect> }> {
  const { payload, req, pageID, target } = input
  const page = await payload.findByID({ collection: 'pages', id: pageID, depth: 0, draft: true, overrideAccess: true, req })
  const pages = await payload.find({ collection: 'pages', limit: 0, pagination: false, depth: 0, draft: true, overrideAccess: true, req })
  let baseline = input.baseline
  if (!baseline) baseline = await queueBaseline(payload, req)
  const removedSectionID = baseline && input.removeNavigationReference ? await removeLegacyNavigationReference(payload, req, baseline, pageID) : undefined
  const references = archiveReferences(pageID, pages.docs as Pick<Page, 'id' | 'parentId' | 'blocks'>[], baseline).filter(reference => !(removedSectionID === reference.id && reference.collection === 'navigation' && reference.field.startsWith('pageIds.')))
  if (references.length) throw new Error(`Archive blocked by references: ${formatArchiveReferences(references)}`)
  const redirect = baseline ? redirectForPublishedChange(baseline, pageID, target) : undefined
  await payload.update({ collection: 'pages', id: page.id, data: { status: 'archived' }, draft: true, overrideAccess: true, req, context: { archiveInternal: true } })
  // Payload reuses the request context from the nested change-set update made
  // by captureChange. Restore this outer editorial operation before creating
  // its redirect so both parts of the archive are captured atomically.
  delete (req.context as Record<string, unknown>).editorialInternal
  if (redirect) {
    const current = await payload.find({ collection: 'redirects', where: { from: { equals: redirect.from } }, limit: 1, depth: 0, overrideAccess: true, req })
    if (current.docs[0] && current.docs[0].to !== redirect.to) throw new Error(`Redirect ${redirect.from} already has a different target.`)
    if (!current.docs[0]) await payload.create({ collection: 'redirects', data: redirect, overrideAccess: true, req })
  }
  return { redirect }
}

/** Called by a trusted edge-log ingestion adapter; public requests never write CMS. */
export async function recordRedirectHit(payload: Payload, req: PayloadRequest, from: string, at = new Date()): Promise<void> {
  const normalized = normalizeRedirectPath(from)
  const result = await payload.find({ collection: 'redirects', where: { from: { equals: normalized } }, limit: 1, depth: 0, overrideAccess: true, req })
  const redirect = result.docs[0]
  if (!redirect) return
  await payload.update({ collection: 'redirects', id: redirect.id, data: { hitCount: Number(redirect.hitCount ?? 0) + 1, lastHitAt: at.toISOString() }, overrideAccess: true, req, context: { redirectHitInternal: true, editorialInternal: true } })
}
