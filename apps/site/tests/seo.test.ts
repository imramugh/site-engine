import { describe, expect, it } from 'vitest';
import { neutralFixture } from '@site-engine/contract/fixtures';
import { llmsText, schemaForRoute, publicModel, sitemapXML } from '../src/lib/seo.js';

const appearance = { background: 'default' as const, width: 'content' as const, spacing: 'default' as const, motionIntent: 'none' as const, logoTone: 'default' as const };

describe('ENG-012 public structured output', () => {
  it('omits an optional sitemap lastmod when a legacy page has no revision time', () => {
    const snapshot = structuredClone(neutralFixture);
    delete snapshot.pages[0].updatedAt;
    const model = publicModel(snapshot, snapshot.settings.homepageId);
    expect(sitemapXML(model, 'https://public.example.test')).not.toContain('<lastmod>');
  });

  it('omits noindex pages from the sitemap', () => {
    const snapshot = structuredClone(neutralFixture);
    snapshot.pages[0].noindex = true;
    const model = publicModel(snapshot, snapshot.settings.homepageId);
    expect(sitemapXML(model, 'https://public.example.test')).not.toContain(snapshot.pages[0].slug);
  });

  it('emits JobPosting only for current, explicit job metadata and visible job detail', () => {
    const snapshot = structuredClone(neutralFixture);
    const section = snapshot.settings.sections[0]; section.allowedTemplates.push('job');
    snapshot.pages.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sectionId: section.id, parentId: snapshot.pages[0].id, title: 'Example role', summary: 'A role summary that is not used as structured job detail.', slug: 'example-role', template: 'job', status: 'published', blocks: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', type: 'richText', body: 'The complete visible role description.', hidden: false, appearance }], jobPosting: { datePosted: '2019-01-01T00:00:00.000Z', employmentType: 'FULL_TIME', location: { addressLocality: 'Example City', addressCountry: 'CA' }, validThrough: '2020-01-01T00:00:00.000Z' } });
    section.pageIds.push(snapshot.pages.at(-1)!.id);
    const model = publicModel(snapshot, snapshot.settings.homepageId);
    const job = model.routes.find((route) => route.page.template === 'job')!;
    expect(JSON.stringify(schemaForRoute(job, model, snapshot, 'https://public.example.test'))).not.toContain('JobPosting');
    job.page.jobPosting!.validThrough = '2099-01-01T00:00:00.000Z';
    const schema = schemaForRoute(job, model, snapshot, 'https://public.example.test');
    const jobPosting = schema['@graph'].find((item) => item['@type'] === 'JobPosting');
    expect(JSON.stringify(jobPosting)).toContain('The complete visible role description.');
    expect(JSON.stringify(jobPosting)).not.toContain('A role summary that is not used as structured job detail.');
  });

  it('uses the reviewed site description in llms.txt and organization profiles', () => {
    const snapshot = structuredClone(neutralFixture)
    snapshot.settings.contractVersion = '1.5.0'
    snapshot.settings.seoDescription = 'A concise reviewed description for public discovery.'
    const model = publicModel(snapshot, snapshot.settings.homepageId)
    expect(llmsText(model, snapshot, 'https://public.example.test')).toContain('\n\nA concise reviewed description for public discovery.\n\n## Pages')
    const schema = schemaForRoute(model.routes[0]!, model, snapshot, 'https://public.example.test')
    expect(schema['@graph'].find(item => item['@type'] === 'Organization')).toMatchObject({ description: snapshot.settings.seoDescription })
  })

  it('uses the semantic symbol output and falls back to the primary logo', () => {
    const snapshot = structuredClone(neutralFixture)
    snapshot.settings.contractVersion = '1.5.0'
    const primary = { id: '10000000-0000-4000-8000-000000000091', filename: 'primary.svg', sha256: 'a'.repeat(64), alt: 'Primary', decorative: false, width: 64, height: 64, mimeType: 'image/svg+xml' as const }
    const symbol = { ...primary, id: '10000000-0000-4000-8000-000000000092', filename: 'symbol.svg' }
    snapshot.media.push(primary, symbol)
    snapshot.settings.logos = { primaryLight: primary, symbolLight: symbol }
    const model = publicModel(snapshot, snapshot.settings.homepageId)
    const schema = schemaForRoute(model.routes[0]!, model, snapshot, 'https://public.example.test')
    expect(schema['@graph'].find(item => item['@type'] === 'Organization')).toMatchObject({ logo: 'https://public.example.test/media/symbol.svg' })
    delete snapshot.settings.logos!.symbolLight
    expect(schemaForRoute(model.routes[0]!, model, snapshot, 'https://public.example.test')['@graph'].find(item => item['@type'] === 'Organization')).toMatchObject({ logo: 'https://public.example.test/media/primary.svg' })
  })
});
