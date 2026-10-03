import { expect, test } from 'vitest'
import { buildContentTree, type ContentTreePage } from '../src/content-tree'

const section = { id: 'section-a', name: 'Section A' }
const page = (id: string, title: string, parentId?: string, sectionId = section.id): ContentTreePage => ({ id, title, template: 'standard', sectionId, parentId })

test('content tree retains more than one Payload page and exposes cycles and missing sections', () => {
  const many = Array.from({ length: 101 }, (_, index) => page(`page-${index}`, `Page ${String(index).padStart(3, '0')}`))
  const cycleA = page('cycle-a', 'Cycle A', 'cycle-b')
  const cycleB = page('cycle-b', 'Cycle B', 'cycle-a')
  const orphan = page('orphan', 'Unknown section', undefined, 'section-missing')
  const tree = buildContentTree([section], [...many, cycleA, cycleB, orphan])
  expect(tree.sections[0]?.roots).toHaveLength(101)
  expect(tree.sections[0]?.unplaced).toHaveLength(1)
  expect(tree.sections[0]?.unplaced[0]?.children[0]?.children[0]?.cycle).toBe(true)
  expect(tree.unassigned.map((node) => node.page.title)).toEqual(['Unknown section'])
})
