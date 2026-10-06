import type { Payload, PayloadRequest } from 'payload'
import { randomUUID } from 'node:crypto'
import type { SiteSnapshot } from '@site-engine/contract'
import { deriveRoutes } from '@site-engine/engine'
import { assetRestoration, currentChange, restoration, snapshot, type CapturedChange } from './editorial'
import { buildCandidate, canonicalHash } from './publishing'
import { loadThemeRegistry, verifyInstalledThemeSelection } from '@site-engine/engine/theme-registry'

/** Reverse approved captures into a new draft. Public removals keep their working
 * copies and media bytes; a guarded tombstone is reviewed like any other change.
 * No published snapshot is mutated and no retention decision is undone. */
export async function captureReviewedRollback(payload: Payload, req: PayloadRequest, actorID: string, name: string, baseline: SiteSnapshot, approved: CapturedChange[]) {
  const keys = new Set(approved.map(change => `${change.collection}:${change.id}`))
  const pending = await payload.find({ collection: 'change-sets', where: { state: { in: ['open', 'submitted', 'changes-requested', 'approved'] } }, limit: 0, pagination: false, depth: 0, overrideAccess: true, req })
  if (pending.docs.some(set => (Array.isArray(set.changes) ? set.changes as CapturedChange[] : []).some(change => keys.has(`${change.collection}:${change.id}`)))) throw new Error('Rollback conflicts with a pending editorial change. Resolve or discard that change first.')
  const changes: CapturedChange[] = approved.map(change => {
    const normalize = (value: Record<string, unknown> | null) => value === null ? null : change.collection === 'assets' ? structuredClone(value) : snapshot(change.collection, value)
    const before = normalize(change.after), after = normalize(change.before)
    return { collection: change.collection, id: change.id, before, after, beforeHash: before ? canonicalHash(before) : null, afterHash: after ? canonicalHash(after) : null }
  })
  // Publication derives redirects when pages move or are archived. Reversing
  // the page must explicitly retire any such redirect occupying its old route.
  // Capture that removal for review even when there is no editable redirect row.
  const routeCandidate = buildCandidate({ ...baseline, redirects: [] }, changes.filter(change => change.collection !== 'redirects'), [...keys], { engineVersion: 'rollback', themeVersion: baseline.settings.theme?.version ?? '1.0.0', contractVersion: baseline.settings.contractVersion })
  const restoredRoutes = new Set(deriveRoutes(routeCandidate).routes.map(route => route.path))
  for (const redirect of baseline.redirects) {
    if (!restoredRoutes.has(redirect.from) || changes.some(change => change.collection === 'redirects' && (change.before?.from === redirect.from || change.after?.from === redirect.from))) continue
    const existing = await payload.find({ collection: 'redirects', where: { from: { equals: redirect.from } }, limit: 1, depth: 0, overrideAccess: true, req })
    const id = existing.docs[0]?.id ?? randomUUID()
    if (pending.docs.some(set => (Array.isArray(set.changes) ? set.changes as CapturedChange[] : []).some(change => change.collection === 'redirects' && change.id === id))) throw new Error('Rollback conflicts with a pending redirect change.')
    changes.push({ collection: 'redirects', id: String(id), before: redirect, after: null, beforeHash: canonicalHash(redirect), afterHash: null })
    keys.add(`redirects:${id}`)
  }
  // Validate the entire reverse operation before modifying any working copy.
  const candidate = buildCandidate(baseline, changes, [...keys], { engineVersion: 'rollback', themeVersion: baseline.settings.theme?.version ?? '1.0.0', contractVersion: baseline.settings.contractVersion })
  if (candidate.settings.theme && canonicalHash(candidate.settings.theme) !== canonicalHash(baseline.settings.theme)) verifyInstalledThemeSelection(candidate.settings.theme, await loadThemeRegistry())
  // Relationships already exist for ordinary reversals. Restore any missing
  // section before its pages, and parent pages before their descendants.
  const remaining = [...changes]
  const ordered: CapturedChange[] = []
  while (remaining.length) {
    const next = remaining.findIndex(change => change.collection === 'sections' || !remaining.some(other => other.collection === 'sections') && (change.collection !== 'pages' || !change.after?.parentId || !remaining.some(other => other.collection === 'pages' && other.id === change.after!.parentId)))
    if (next < 0) throw new Error('Rollback page hierarchy is cyclic.')
    ordered.push(remaining.splice(next, 1)[0]!)
  }
  for (const change of ordered) {
    const found = await payload.find({ collection: change.collection, where: { id: { equals: change.id } }, limit: 1, depth: 0, draft: true, overrideAccess: true, req })
    const current = found.docs[0] as unknown as Record<string, unknown> | undefined
    if (change.collection === 'assets' && (!current || current.deletedAt)) throw new Error('A rollback asset is unavailable or in the deletion bin. Restore retained media through its lifecycle first; purged media cannot be recovered by rollback.')
    if (current && change.before) {
      const observed = currentChange(change.collection, current, change.before)!
      // Older captures predate the materialized false default.
      if (change.collection === 'pages' && observed.noindex === false && !('noindex' in change.before)) delete observed.noindex
      if (canonicalHash(observed) !== canonicalHash(change.before)) throw new Error('Rollback conflicts with a later draft edit. Resolve that draft before preparing a reversal.')
    }
    if (!change.after) {
      change.retainedDraftHash = canonicalHash(currentChange(change.collection, current, change.before))
      continue
    }
    const data = change.collection === 'assets' && current
      ? await assetRestoration(payload, req, current, change.after)
      : restoration(change.collection, change.after)
    if (change.collection === 'pages' && change.after.status === 'archived') data.status = 'archived'
    const context = { editorialInternal: true, reviewedSnapshotImport: true, ...(change.collection === 'pages' && change.after.status === 'archived' ? { archiveInternal: true } : {}), ...(change.collection === 'assets' ? { mediaReplacement: true } : {}) }
    const saved = current
      ? await payload.update({ collection: change.collection, id: change.id, data, draft: true, overrideAccess: true, req, context })
      : await payload.create({ collection: change.collection, data: { id: change.id, ...data }, draft: true, overrideAccess: true, req, context })
    // Persist the actual normalized draft so normal submit/staleness/discard
    // checks use exactly the same representation as ordinary editor changes.
    let after = snapshot(change.collection, saved as unknown as Record<string, unknown>, 'focalX' in change.after || 'focalY' in change.after)!
    if (change.collection === 'pages') for (const field of ['kicker', 'lede', 'seoDescription', 'publishedAt', 'lastReviewed', 'jobPosting', 'businessCase']) if (after[field] === null && !(change.before && field in change.before)) delete after[field]
    if (change.collection === 'site-settings') after = Object.fromEntries(Object.entries(after).filter(([key, value]) => value !== null || Boolean(change.before && key in change.before)))
    change.after = after; change.afterHash = canonicalHash(after)
  }
  buildCandidate(baseline, changes, [...keys], { engineVersion: 'rollback', themeVersion: baseline.settings.theme?.version ?? '1.0.0', contractVersion: baseline.settings.contractVersion })
  const set = await payload.create({ collection: 'change-sets', data: { name, actor: actorID, state: 'open', revision: 0, changes }, overrideAccess: true, req, context: { editorialInternal: true } })
  await payload.create({ collection: 'audit-events', data: { event: 'editorial.rollback_prepared', actor: actorID, user: actorID, detail: { changeSet: set.id, includedChangeKeys: [...keys] } }, overrideAccess: true, req })
  return set as unknown as Record<string, unknown>
}
