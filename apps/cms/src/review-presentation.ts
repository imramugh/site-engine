import { fieldDiffs, type FieldDiff } from './field-diffs'

export type PresentedChange = {
  collection: string
  id: string
  before: unknown
  after: unknown
}

export const historyStates = new Set(['approved', 'rejected', 'published', 'discarded'])

export function belongsToReviewView(state: string, view: 'pending' | 'history'): boolean {
  return view === 'history' ? historyStates.has(state) : !historyStates.has(state)
}

export function words(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').replace(/^./, (letter) => letter.toUpperCase())
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function changeTitle(change: PresentedChange): string {
  const current = record(change.after) ?? record(change.before)
  for (const key of ['title', 'name', 'heading', 'label', 'alt']) {
    if (typeof current?.[key] === 'string' && current[key]) return String(current[key])
  }
  return words(change.collection.replace(/s$/, ''))
}

export function changeKind(collection: string): string {
  const known: Record<string, string> = {
    pages: 'Page', sections: 'Section', assets: 'Media', 'site-settings': 'Site settings',
    'theme-settings': 'Theme', redirects: 'Redirect', applications: 'Application', inquiries: 'Lead',
  }
  return known[collection] ?? words(collection.replace(/s$/, ''))
}

export function relevantDiffs(change: PresentedChange, limit = 12): FieldDiff[] {
  return fieldDiffs(change.before, change.after, limit).filter(([field]) => !/(^| › )(id|createdAt|updatedAt)$/i.test(field))
}

export function readableValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'Not set'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) {
    if (value.length === 0) return 'None'
    if (value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) return value.join(', ')
    return `${value.length} item${value.length === 1 ? '' : 's'}`
  }
  const valueRecord = record(value)
  if (valueRecord) {
    for (const key of ['title', 'heading', 'name', 'label', 'text', 'body', 'summary', 'slug']) {
      if (typeof valueRecord[key] === 'string' && valueRecord[key]) return String(valueRecord[key])
    }
    return `${Object.keys(valueRecord).length} structured field${Object.keys(valueRecord).length === 1 ? '' : 's'}`
  }
  return String(value)
}
