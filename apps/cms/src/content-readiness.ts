import { isDeepStrictEqual } from 'node:util'
import { snapshot } from './editorial'
import { checkSiteSnapshot } from '@site-engine/checks'

export type PublishedPageCheck =
  | { state: 'checked'; issues: number }
  | { state: 'not-published' }
  | { state: 'unavailable' }

/** Readiness results describe only the immutable published version. The UI
 * labels their scope explicitly; they never certify the working draft. */
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
  return checks?.get(page.id) ?? (checks ? { state: 'not-published' } : { state: 'unavailable' })
}

/** Published state comes from the immutable release, never Payload's draft flag. */
export function workingPageState(page: Record<string, unknown>, released?: Record<string, unknown>): 'published' | 'draft-changes' | 'draft' | 'archived' {
  if (page.status === 'archived') return 'archived'
  if (!released || released.status !== 'published') return 'draft'
  const comparable = (document: Record<string, unknown>) => {
    const value = snapshot('pages', document)!
    if (value.seoDescription == null) delete value.seoDescription
    if (value.businessCase == null) delete value.businessCase
    value.noindex = value.noindex === true
    return value
  }
  return isDeepStrictEqual(comparable(page), comparable(released)) ? 'published' : 'draft-changes'
}
