import { describe, expect, it } from 'vitest';
import { SiteSnapshotSchema } from '@site-engine/contract';
import { deriveRoutes, resolveSiteNavigation } from '../src/index.js';

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
  it('rejects a homepage hidden beneath an unpublished ancestor', () => {
    const hiddenHome = structuredClone(snapshot);
    hiddenHome.pages[0].parentId = ids.pillar;
    hiddenHome.pages[1].status = 'draft';
    expect(() => deriveRoutes(hiddenHome, ids.root)).toThrow('Homepage cannot be hidden');
  });
  it('resolves reviewed navigation ordering, unavailable states, contact visibility, and UTC year', () => {
    const value = structuredClone(snapshot);
    value.settings.contractVersion = '1.6.0'; value.settings.homepageId = ids.root;
    value.settings.sections[0]!.landingPageId = ids.root; value.pages[1]!.parentId = ids.root;
    value.settings.contactEmail = 'hello@example.test'; value.settings.contactPhone = '+1 555 0100';
    value.settings.navigation = {
      header: [{ kind: 'page', id: ids.root, label: 'Home', style: 'link' }, { kind: 'unavailable', label: 'Insights', reason: 'Insights are not published.', style: 'button' }],
      footer: { columns: [
        { kind: 'section-pillars', heading: 'Services', sectionId: ids.section },
        { kind: 'contact', heading: 'Contact', fields: ['email', 'address', 'phone'] },
      ], bottomLinks: [{ kind: 'unavailable', label: 'Privacy', reason: 'Privacy is not published.' }], copyright: '© {year} Sample' },
    };
    const draftPillar = { ...structuredClone(value.pages[1]), id: '70000000-0000-4000-8000-000000000000', title: 'Draft pillar', slug: 'draft-pillar', status: 'draft' as const };
    const nestedPillar = { ...structuredClone(value.pages[1]), id: '80000000-0000-4000-8000-000000000000', title: 'Nested pillar', slug: 'nested-pillar', parentId: ids.pillar };
    value.pages.push(draftPillar, nestedPillar); value.settings.sections[0]!.pageIds = [draftPillar.id, ids.pillar, nestedPillar.id, ids.service];
    const resolved = resolveSiteNavigation(value, 2031);
    expect(resolved.header).toEqual([{ label: 'Home', style: 'link', href: '/' }, { label: 'Insights', style: 'button', unavailableReason: 'Insights are not published.' }]);
    expect(resolved.footer.columns[0]).toEqual({ kind: 'section-pillars', heading: 'Services', items: [{ label: 'Area', style: 'link', href: '/services/area' }] });
    expect(resolved.footer.columns[1]).toMatchObject({ kind: 'contact', items: [{ field: 'email', value: 'hello@example.test' }, { field: 'phone', value: '+1 555 0100' }] });
    expect(resolved.footer.bottomLinks[0]).not.toHaveProperty('href'); expect(resolved.footer.copyright).toBe('© 2031 Sample');
  });

});
