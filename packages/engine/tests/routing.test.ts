import { describe, expect, it } from 'vitest';
import { SiteSnapshotSchema } from '@site-engine/contract';
import { HEADER_SERVICE_LIMIT, deriveRoutes, headerServiceNavigation, serviceNavigation } from '../src/index.js';

const ids = { section: '10000000-0000-4000-8000-000000000000', root: '20000000-0000-4000-8000-000000000000', pillar: '30000000-0000-4000-8000-000000000000', service: '40000000-0000-4000-8000-000000000000' };
const appearance = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } as const;
const snapshot = SiteSnapshotSchema.parse({ settings: { contractVersion: '1.0.0', siteName: 'Sample', defaultLocale: 'en', sections: [{ id: ids.section, name: 'Services', slug: 'services', allowedTemplates: ['landing', 'pillar', 'service'], pageIds: Object.values(ids).slice(1) }] }, pages: [
  { id: ids.root, sectionId: ids.section, title: 'Home', summary: 'Home summary.', slug: 'home', template: 'landing', status: 'published', updatedAt: '2026-10-02T12:00:00.000Z', blocks: [{ id: '50000000-0000-4000-8000-000000000000', type: 'hero', heading: 'Home', body: 'Body', appearance }] },
  { id: ids.pillar, sectionId: ids.section, title: 'Area', summary: 'Area summary.', slug: 'area', template: 'pillar', status: 'published', updatedAt: '2026-10-02T12:00:00.000Z', blocks: [] },
  { id: ids.service, sectionId: ids.section, parentId: ids.pillar, title: 'Detail', summary: 'Detail summary.', slug: 'detail', template: 'service', status: 'published', updatedAt: '2026-10-02T12:00:00.000Z', blocks: [] },
], media: [], redirects: [{ from: '/old', to: '/services/area', status: 301 }], changeSets: [] });
describe('ENG-004 generic routing', () => {
  it('derives public paths, breadcrumbs, and redirects from published tree data', () => { const model = deriveRoutes(snapshot, ids.root); expect(model.byPath.get('/services/area/detail')?.breadcrumbs.map((item) => item.label)).toEqual(['Home', 'Area', 'Detail']); expect(model.redirects.get('/old')).toBe('/services/area'); });
  it('omits draft pages and rejects a duplicate generated path', () => { const draft = structuredClone(snapshot); draft.pages[2].status = 'draft'; expect(deriveRoutes(draft, ids.root).byPath.has('/services/area/detail')).toBe(false); const duplicate = structuredClone(snapshot); duplicate.pages.push({ ...duplicate.pages[1], id: '60000000-0000-4000-8000-000000000000' }); expect(() => deriveRoutes(duplicate, ids.root)).toThrow('Sibling page slugs must be unique'); });
  it('uses the section path for its landing page and omits its slug from descendants', () => {
    const sectionLanding = structuredClone(snapshot);
    sectionLanding.settings.sections[0].landingPageId = ids.pillar;
    const model = deriveRoutes(sectionLanding, ids.root);
    expect(model.byPath.get('/services')?.page.id).toBe(ids.pillar);
    expect(model.byPath.get('/services/detail')?.page.id).toBe(ids.service);
  });

  it('keeps all published services in the footer model while bounding alphabetical header services with a warning', () => {
    const manyServices = structuredClone(snapshot);
    const names = ['Zeta', 'Alpha', 'Gamma', 'Beta', 'Epsilon', 'Delta', 'Eta'];
    for (const [index, title] of names.entries()) {
      const id = `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      manyServices.pages.push({ ...manyServices.pages[2]!, id, title, slug: title.toLowerCase(), parentId: ids.pillar });
      manyServices.settings.sections[0]!.pageIds.push(id);
    }
    const model = deriveRoutes(manyServices, ids.root);
    expect(serviceNavigation(model).map((route) => route.page.title)).toEqual(['Alpha', 'Beta', 'Delta', 'Detail', 'Epsilon', 'Eta', 'Gamma', 'Zeta']);
    expect(headerServiceNavigation(model).map((route) => route.page.title)).toEqual(['Alpha', 'Beta', 'Delta', 'Detail', 'Epsilon', 'Eta']);
    expect(headerServiceNavigation(model)).toHaveLength(HEADER_SERVICE_LIMIT);
    expect(model.warnings).toContain('Header has more than 6 service pages; excess services are footer-only.');
  });

  it('rejects a homepage hidden beneath an unpublished ancestor', () => {
    const hiddenHome = structuredClone(snapshot);
    hiddenHome.pages[0].parentId = ids.pillar;
    hiddenHome.pages[1].status = 'draft';
    expect(() => deriveRoutes(hiddenHome, ids.root)).toThrow('Homepage cannot be hidden');
  });

});
