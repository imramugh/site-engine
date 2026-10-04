import { checkSiteSnapshot } from '@site-engine/checks'

export type PublishedPageCheck =
  | { state: 'checked'; issues: number }
  | { state: 'not-published' }
  | { state: 'unavailable' }

/** A release snapshot is immutable. Its checks are useful only for pages that
 * are still published in the working copy; drafts must never inherit them. */
export function publishedPageChecks(manifest: unknown): Map<string, PublishedPageCheck> | undefined {
  if (!manifest || typeof manifest !== 'object') return undefined
  const report = checkSiteSnapshot(manifest, { asOf: new Date() })
  if (report.blockers.some((issue) => !issue.pageId)) return undefined
  const published = new Set(Array.isArray((manifest as { pages?: unknown }).pages)
    ? ((manifest as { pages: Array<{ id?: unknown; status?: unknown }> }).pages)
      .filter((page) => page.status === 'published' && typeof page.id === 'string')
      .map((page) => page.id as string)
    : [])
  const counts = new Map<string, number>()
  for (const issue of report.issues) if (issue.pageId) counts.set(issue.pageId, (counts.get(issue.pageId) ?? 0) + 1)
  return new Map([...published].map((id) => [id, { state: 'checked', issues: counts.get(id) ?? 0 }]))
}

export function checkForWorkingPage(page: { id: string; status?: string | null; _status?: string | null }, checks: Map<string, PublishedPageCheck> | undefined): PublishedPageCheck {
  if ((page.status ?? page._status ?? 'draft') !== 'published') return { state: 'not-published' }
  return checks?.get(page.id) ?? (checks ? { state: 'not-published' } : { state: 'unavailable' })
}
