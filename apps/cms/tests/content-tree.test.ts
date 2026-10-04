import { expect, test } from 'vitest'
import { deriveRoutes } from '@site-engine/engine'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { buildContentTree, canonicalContentPath, type ContentTreePage } from '../src/content-tree'

const section = { id: 'section-a', name: 'Section A' }
const page = (id: string, title: string, parentId?: string, sectionId = section.id): ContentTreePage => ({ id, title, slug: id, template: 'standard', sectionId, parentId })

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

test('canonical content paths match engine routes for the homepage and section landing page', () => {
  const snapshot = structuredClone(neutralFixture)
  const servicesID = '66666666-6666-4666-8666-666666666666'
  const landingID = '77777777-7777-4777-8777-777777777777'
  const detailID = '88888888-8888-4888-8888-888888888888'
  snapshot.settings.sections.push({ id: servicesID, name: 'Services', slug: 'services', landingPageId: landingID, allowedTemplates: ['pillar', 'service'], pageIds: [landingID, detailID] })
  snapshot.pages.push(
    { id: landingID, sectionId: servicesID, title: 'Services', summary: 'A synthetic services landing page for route semantics.', slug: 'services', template: 'pillar', status: 'published', blocks: [] },
    { id: detailID, sectionId: servicesID, parentId: landingID, title: 'Respond', summary: 'A synthetic child page for route semantics.', slug: 'respond', template: 'service', status: 'published', blocks: [] },
  )
  const model = deriveRoutes(snapshot)
  const sections = snapshot.settings.sections.map(({ id, name, slug, landingPageId }) => ({ id, name, slug, landingPageId }))
  for (const page of snapshot.pages) {
    expect(canonicalContentPath(page, snapshot.pages, sections, snapshot.settings.homepageId)).toBe(model.routes.find((route) => route.page.id === page.id)?.path)
  }
  expect(canonicalContentPath(snapshot.pages.find((item) => item.id === landingID)!, snapshot.pages, sections, snapshot.settings.homepageId)).toBe('/services')
  expect(canonicalContentPath(snapshot.pages.find((item) => item.id === detailID)!, snapshot.pages, sections, snapshot.settings.homepageId)).toBe('/services/respond')
})
