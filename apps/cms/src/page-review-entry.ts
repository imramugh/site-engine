import type { Payload } from 'payload'
import { loadReviewModeData } from './review-mode'

export type PageReviewEntry = { id: string; name: string; revision: number; path: string; freshApproval: boolean }

export function canonicalReviewPath(value: string): string | undefined {
  const raw = value.split('?', 1)[0]
  if (!raw.startsWith('/') || raw.length > 1024 || /[\\%#\0]/.test(raw) || raw.split('/').some((part) => part === '.' || part === '..')) return undefined
  return raw.length > 1 ? raw.replace(/\/+$/, '') : '/'
}

/** Finds only current, immutable, submitted comparisons for one canonical page. */
export async function pageReviewEntries(payload: Payload, path: string, freshApproval: boolean): Promise<PageReviewEntry[]> {
  const canonical = canonicalReviewPath(path)
  if (!canonical) return []
  const sets = await payload.find({ collection: 'change-sets', where: { state: { equals: 'submitted' } }, sort: '-submittedAt', limit: 50, depth: 0, overrideAccess: true })
  const entries: PageReviewEntry[] = []
  for (const set of sets.docs) {
    try {
      const review = await loadReviewModeData(payload, String(set.id))
      if (canonicalReviewPath(review.path) !== canonical || (!review.changedBlocks.length && !review.pageFields.length)) continue
      entries.push({ id: review.id, name: review.name, revision: review.revision, path: review.path, freshApproval })
    } catch {
      // A stale or incomplete comparison is never an on-page entry.
    }
  }
  return entries
}
