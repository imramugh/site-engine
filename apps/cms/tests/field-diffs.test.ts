import { expect, test } from 'vitest'
import { fieldDiffs } from '../src/field-diffs'

test('shows changed block text instead of equal array item counts', () => {
  const before = { blocks: [{ id: 'hero', type: 'hero', heading: 'Before', body: 'Old body' }] }
  const after = { blocks: [{ id: 'hero', type: 'hero', heading: 'After', body: 'New body' }] }
  const changes = fieldDiffs(before, after)
  expect(changes).toEqual([
    ['blocks › After › heading', 'Before', 'After'],
    ['blocks › After › body', 'Old body', 'New body'],
  ])
})
test('matches reordered blocks by ID without inventing text changes', () => {
  const blocks = [{ id: 'one', type: 'hero', heading: 'One' }, { id: 'two', type: 'text', heading: 'Two' }]
  expect(fieldDiffs({ blocks }, { blocks: [blocks[1], blocks[0]] })).toEqual([['blocks order', ['One', 'Two'], ['Two', 'One']]])
})
test('includes added nested values and retains complete data when bounded', () => {
  const after = { blocks: [{ id: 'faq', type: 'faq', items: [{ question: 'New question?', answer: 'Actual answer.' }] }] }
  expect(fieldDiffs({}, after).some(([name, , value]) => name.endsWith('answer') && value === 'Actual answer.')).toBe(true)
  const bounded = fieldDiffs({}, after, 2)
  expect(bounded).toHaveLength(3)
  expect(bounded[2]).toEqual(['Additional changes (complete values)', {}, after])
})

test('preserves empty collection and changed value type differences', () => {
  expect(fieldDiffs({}, { items: [], config: {} })).toEqual([['items', undefined, []], ['config', undefined, {}]])
  expect(fieldDiffs({ value: 'Old' }, { value: { text: 'New' } })).toEqual([['value', 'Old', { text: 'New' }]])
})

test('expands a newly captured document whose previous snapshot is null', () => {
  expect(fieldDiffs(null, { title: 'New page' })).toEqual([['title', undefined, 'New page']])
})
