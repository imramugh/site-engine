import { describe, expect, it } from 'vitest'
import { belongsToReviewView, changeKind, changeTitle, readableValue, relevantDiffs } from '../src/review-presentation'

describe('review presentation', () => {
  it('keeps terminal records in deliberate history while active work stays pending', () => {
    expect(['open', 'submitted', 'changes-requested', 'approved', 'stale', 'rejected'].filter((state) => belongsToReviewView(state, 'pending'))).toEqual(['open', 'submitted', 'changes-requested', 'stale'])
    expect(['open', 'approved', 'rejected', 'published', 'discarded'].filter((state) => belongsToReviewView(state, 'history'))).toEqual(['approved', 'rejected', 'published', 'discarded'])
  })

  it('names records and presents bounded readable leaf changes without record metadata', () => {
    const change = { collection: 'pages', id: 'opaque-id', before: { id: 'opaque-id', title: 'Incident response', updatedAt: 'old', blocks: [{ id: 'hero', type: 'hero', heading: 'Old heading' }] }, after: { id: 'opaque-id', title: 'Incident response', updatedAt: 'new', blocks: [{ id: 'hero', type: 'hero', heading: 'Clear new heading' }] } }
    expect(changeTitle(change)).toBe('Incident response')
    expect(changeKind(change.collection)).toBe('Page')
    expect(relevantDiffs(change)).toEqual([['blocks › Clear new heading › heading', 'Old heading', 'Clear new heading']])
    expect(readableValue({ heading: 'Clear new heading', body: 'Body' })).toBe('Clear new heading')
  })
})
