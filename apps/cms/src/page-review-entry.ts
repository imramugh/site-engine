import type { Payload } from 'payload'
import { loadReviewModePages } from './review-mode'

export type PageReviewEntry = { id: string; name: string; revision: number; path: string; pageID?: string; freshApproval: boolean }

export function canonicalReviewPath(value: string): string | undefined {
  const raw = value.split('?', 1)[0]
  if (!raw.startsWith('/') || raw.length > 1024 || /[\\%#\0]/.test(raw) || raw.split('/').some((part) => part === '.' || part === '..')) return undefined
  return raw.length > 1 ? raw.replace(/\/+$/, '') : '/'
}

/** Finds only current, immutable, submitted comparisons for one canonical page. */
export async function pageReviewEntries(payload: Payload, path: string, freshApproval: boolean): Promise<PageReviewEntry[]> {
  const canonical = canonicalReviewPath(path)
  if (!canonical) return []
  const entries: PageReviewEntry[] = []
  const pageSize = 50
  const maxPages = 20
  for (let page = 1; page <= maxPages; page += 1) {
    const sets = await payload.find({ collection: 'change-sets', where: { state: { equals: 'submitted' } }, sort: '-submittedAt', page, limit: pageSize, depth: 0, overrideAccess: true })
    for (const set of sets.docs) {
      try {
        const reviews = await loadReviewModePages(payload, String(set.id))
        for (const review of reviews) {
          if (canonicalReviewPath(review.path) !== canonical || (!review.changedBlocks.length && !review.pageFields.length)) continue
          entries.push({ id: review.id, name: review.name, revision: review.revision, path: review.path, pageID: review.pageID, freshApproval })
        }
      } catch {
        // A stale or incomplete comparison is never an on-page entry.
      }
    }
    if (!sets.hasNextPage) return entries
  }
  throw new Error('Too many submitted change sets to determine page review eligibility safely.')
}
