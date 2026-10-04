import { NotFound, type Payload, type PayloadRequest } from 'payload'
import { SiteSnapshotSchema, type SiteSnapshot } from '@site-engine/contract'
import { hasRole, type Role } from './access'
import { snapshot, type CapturedCollection } from './editorial'
import { buildCandidate, canonicalHash } from './publishing'

type Actor = { id: string; roles?: Role[] | null; disabled?: boolean | null }
type ImportInput = { payload: Payload; req: PayloadRequest; actor: Actor | undefined; name: string; manifest: unknown; baseline: unknown }
type Captured = { collection: CapturedCollection; id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; beforeHash: string | null; afterHash: string | null }
const same = (left: unknown, right: unknown) => canonicalHash(left) === canonicalHash(right)

function baselineFor(collection: CapturedCollection, baseline: SiteSnapshot, id: string): Record<string, unknown> | undefined {
  if (collection === 'sections') return baseline.settings.sections.find(item => item.id === id) as unknown as Record<string, unknown> | undefined
  if (collection === 'pages') return baseline.pages.find(item => item.id === id) as unknown as Record<string, unknown> | undefined
  if (collection === 'redirects') return baseline.redirects.find(item => item.from === id) as unknown as Record<string, unknown> | undefined
  return undefined
}
function capture(changes: Captured[], collection: CapturedCollection, id: string, beforeDocument: Record<string, unknown> | undefined, afterDocument: Record<string, unknown>) {
  let before = snapshot(collection, beforeDocument)
  let after = snapshot(collection, afterDocument)
  // Payload materializes an omitted optional SEO description as null. Keep
  // null only when it clears a description present in the frozen baseline.
  if (collection === 'pages') {
    if (before?.seoDescription === null) { const { seoDescription: _seoDescription, ...normalized } = before; before = normalized }
    if (after?.seoDescription === null && !(before && 'seoDescription' in before)) { const { seoDescription: _seoDescription, ...normalized } = after; after = normalized }
    if (before?.businessCase === null) { const { businessCase: _businessCase, ...normalized } = before; before = normalized }
    if (after?.businessCase === null) { const { businessCase: _businessCase, ...normalized } = after; after = normalized }
  }
  const existing = changes.findIndex(change => change.collection === collection && change.id === id)
  if (same(before, after)) {
    // A later relationship write can restore the frozen value after an
    // earlier intermediate save was captured; remove that transient change.
    if (existing >= 0 && same(changes[existing]!.before, after)) changes.splice(existing, 1)
    return
  }
  const next: Captured = { collection, id, before, after, beforeHash: before ? canonicalHash(before) : null, afterHash: after ? canonicalHash(after) : null }
  if (existing >= 0) { next.before = changes[existing]!.before; next.beforeHash = changes[existing]!.beforeHash; changes[existing] = next } else changes.push(next)
}
async function findDraftByID(payload: Payload, req: PayloadRequest, collection: 'sections' | 'pages', id: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await payload.findByID({ collection, id, depth: 0, draft: true, overrideAccess: true, req }) as unknown as Record<string, unknown>
  } catch (error) {
    if (error instanceof NotFound) return undefined
    throw error
  }
}

/** Reconciles a contract-valid desired snapshot into ordinary draft records, then
 * creates one named review set with exact published before-images. Published
 * releases are read-only inputs and this operation never queues publication. */
export async function importReviewedSnapshot(input: ImportInput): Promise<Record<string, unknown>> {
  const { payload, req } = input
  if (!input.actor || !hasRole(input.actor, ['owner'])) throw new Error('Owner role required.')
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw new Error('A change-set name of at most 120 characters is required.')
  const manifest = SiteSnapshotSchema.parse(input.manifest)
  const baseline = SiteSnapshotSchema.parse(input.baseline)
  if (manifest.media.some(asset => !baseline.media.some(existing => existing.id === asset.id))) throw new Error('Import new media through the asset upload workflow before snapshot reconciliation.')
  if (manifest.pages.some(page => page.status !== 'published')) throw new Error('Only published pages may be reconciled through snapshot import.')
  const [siteSettings, existingRedirects] = await Promise.all([
    payload.find({ collection: 'site-settings', limit: 1, depth: 0, draft: true, overrideAccess: true, req }),
    manifest.redirects.length ? payload.find({ collection: 'redirects', where: { from: { in: manifest.redirects.map(redirect => redirect.from) } }, limit: 0, pagination: false, depth: 0, draft: true, overrideAccess: true, req }) : Promise.resolve({ docs: [] }),
  ])
  const pending = await payload.find({ collection: 'change-sets', where: { state: { in: ['open', 'submitted', 'changes-requested', 'approved'] } }, limit: 0, pagination: false, depth: 0, overrideAccess: true, req })
  const touched = new Set((pending.docs.flatMap(set => Array.isArray(set.changes) ? set.changes : []) as { collection?: unknown; id?: unknown }[]).flatMap(change => typeof change.collection === 'string' && typeof change.id === 'string' ? [`${change.collection}:${change.id}`] : []))
  const requested = [
    ...manifest.settings.sections.map(section => `sections:${section.id}`),
    ...manifest.pages.map(page => `pages:${page.id}`),
    ...existingRedirects.docs.map(redirect => `redirects:${redirect.id}`),
    ...siteSettings.docs.map(settings => `site-settings:${settings.id}`),
  ]
  if (requested.some(key => touched.has(key))) throw new Error('Snapshot reconciliation conflicts with a pending editorial change. Resolve or discard that change first.')
  const changes: Captured[] = []
  // Sections first, without page relations; pages can then reference them.
  for (const section of manifest.settings.sections) {
    const existing = await findDraftByID(payload, req, 'sections', section.id)
    const { id: _id, pageIds: _pageIds, landingPageId: _landingPageId, ...data } = section
    const saved = existing ? await payload.update({ collection: 'sections', id: section.id, data, draft: true, overrideAccess: true, req, context: { editorialInternal: true } }) : await payload.create({ collection: 'sections', data: { id: section.id, ...data }, draft: true, overrideAccess: true, req, context: { editorialInternal: true } })
    capture(changes, 'sections', section.id, baselineFor('sections', baseline, section.id), saved as unknown as Record<string, unknown>)
  }
  const remaining = new Map(manifest.pages.map(page => [page.id, page]))
  const orderedPages: SiteSnapshot['pages'] = []
  while (remaining.size) {
    const ready = [...remaining.values()].filter(page => !page.parentId || orderedPages.some(parent => parent.id === page.parentId) || !remaining.has(page.parentId))
    if (!ready.length) throw new Error('Imported page parents must form an acyclic hierarchy.')
    for (const page of ready) { orderedPages.push(page); remaining.delete(page.id) }
  }
  for (const page of orderedPages) {
    const existing = await findDraftByID(payload, req, 'pages', page.id)
    const { id: _id, status: _status, ...data } = page
    const saved = existing ? await payload.update({ collection: 'pages', id: page.id, data, draft: true, overrideAccess: true, req, context: { editorialInternal: true } }) : await payload.create({ collection: 'pages', data: { id: page.id, ...data }, draft: true, overrideAccess: true, req, context: { editorialInternal: true } })
    capture(changes, 'pages', page.id, baselineFor('pages', baseline, page.id), saved as unknown as Record<string, unknown>)
  }
  for (const section of manifest.settings.sections) {
    const saved = await payload.update({ collection: 'sections', id: section.id, data: { pageIds: section.pageIds, landingPageId: section.landingPageId }, draft: true, overrideAccess: true, req, context: { editorialInternal: true } })
    // Relationship updates are persisted separately by Payload and may not be
    // populated in its update result. Capture the reviewed IDs we just wrote.
    capture(changes, 'sections', section.id, baselineFor('sections', baseline, section.id), { ...(saved as unknown as Record<string, unknown>), pageIds: section.pageIds, ...(section.landingPageId ? { landingPageId: section.landingPageId } : {}) })
  }
  for (const redirect of manifest.redirects) {
    const existing = existingRedirects.docs.find(candidate => candidate.from === redirect.from)
    const saved = existing ? await payload.update({ collection: 'redirects', id: existing.id, data: redirect, draft: true, overrideAccess: true, req, context: { editorialInternal: true } }) : await payload.create({ collection: 'redirects', data: redirect, draft: true, overrideAccess: true, req, context: { editorialInternal: true } })
    capture(changes, 'redirects', String(saved.id), baselineFor('redirects', baseline, redirect.from), saved as unknown as Record<string, unknown>)
  }
  const data = { siteName: manifest.settings.siteName, homepageId: manifest.settings.homepageId, defaultLocale: manifest.settings.defaultLocale, organizationType: manifest.settings.organizationType, logo: manifest.settings.logo?.id, contactEmail: manifest.settings.contactEmail, contactPhone: manifest.settings.contactPhone, seoDescription: manifest.settings.seoDescription, searchEnabled: manifest.settings.searchEnabled }
  const saved = siteSettings.docs[0] ? await payload.update({ collection: 'site-settings', id: siteSettings.docs[0].id, data, draft: true, overrideAccess: true, req, context: { editorialInternal: true } }) : await payload.create({ collection: 'site-settings', data, draft: true, overrideAccess: true, req, context: { editorialInternal: true } })
  capture(changes, 'site-settings', String(saved.id), baseline.settings as unknown as Record<string, unknown>, saved as unknown as Record<string, unknown>)
  buildCandidate(baseline, changes as never, changes.map(change => `${change.collection}:${change.id}`), { themeVersion: manifest.settings.theme?.version ?? '0.0.0', engineVersion: 'snapshot-import', contractVersion: manifest.settings.contractVersion })
  const set = await payload.create({ collection: 'change-sets', data: { name: input.name.trim(), actor: input.actor.id, state: 'open', revision: 0, changes }, overrideAccess: true, req, context: { editorialInternal: true } })
  await payload.create({ collection: 'audit-events', data: { event: 'editorial.snapshot_imported', user: input.actor.id, actor: input.actor.id, detail: { changeSet: set.id, pages: manifest.pages.length, sections: manifest.settings.sections.length } }, overrideAccess: true, req })
  return set as unknown as Record<string, unknown>
}
