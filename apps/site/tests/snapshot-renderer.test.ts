import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { neutralFixture } from '@site-engine/contract/fixtures';
import type { SiteSnapshot } from '@site-engine/contract';

const renderer = await import('../scripts/build-snapshot.mjs');
const BASE_PATH = '/preview/changes/test/proposed/';
const PUBLIC_ORIGIN = 'https://public.example.test';
const stable = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
    : JSON.stringify(value);
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');

it('reports an invalid snapshot build with its public page and block location', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-invalid-diagnostic-'));
  try {
    const snapshot = fixture('Invalid diagnostic');
    const page = snapshot.pages[0]!; const block = page.blocks[0]!;
    if (block.type !== 'hero') throw new Error('Fixture must start with a hero.');
    block.heading = '';
    const input = await writeSnapshot(root, snapshot, 'invalid.json');
    const priorTheme = process.env.SITE_THEME_VERSION; const priorEngine = process.env.SITE_ENGINE_VERSION;
    process.env.SITE_THEME_VERSION = '1.0.0'; process.env.SITE_ENGINE_VERSION = '1.0.0';
    await expect(renderer.buildSnapshot({ input, publicOrigin: PUBLIC_ORIGIN, outputRoot: root })).rejects.toThrow(`page \"${page.title}\" (${page.id}), block hero (${block.id}): pages[0].blocks[0].heading`);
    process.env.SITE_THEME_VERSION = priorTheme; process.env.SITE_ENGINE_VERSION = priorEngine;
  } finally { await rm(root, { recursive: true, force: true }); }
});

function fixture(name: string): SiteSnapshot {
  const snapshot = structuredClone(neutralFixture);
  const section = snapshot.settings.sections[0];
  snapshot.settings.organizationType = 'professional-service';
  section.name = `${name} section`;
  section.slug = 'docs';
  section.allowedTemplates = ['landing', 'listing', 'pillar', 'service', 'article'];
  const home = snapshot.pages[0];
  home.title = `${name} home`;
  home.summary = `${name} home summary`;
  const hero = home.blocks[0];
  if (hero.type !== 'hero') throw new Error('The neutral fixture must start with a hero.');
  home.blocks[0] = { ...hero, heading: `${name} home heading`, cta: { label: 'Read the docs', href: '/docs' } };
  const listingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const pillarId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const serviceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const articleId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const draftId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const archiveId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const appearance = { background: 'default' as const, width: 'content' as const, spacing: 'default' as const, motionIntent: 'none' as const, logoTone: 'default' as const };
  snapshot.media = [
    { id: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'sample-image.svg', alt: 'Synthetic sample image', decorative: false, width: 640, height: 360, mimeType: 'image/svg+xml' },
    { id: '22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'sample-poster.svg', alt: 'Synthetic video poster', decorative: false, width: 640, height: 360, mimeType: 'image/svg+xml' },
    { id: '33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'sample-video.webm', alt: 'Synthetic sample video', decorative: false, mimeType: 'video/webm' },
    { id: '44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'sample-captions.vtt', decorative: true, mimeType: 'text/vtt' },
  ];
  snapshot.pages.push(
    { id: listingId, sectionId: section.id, title: `${name} docs`, summary: 'Published documentation index.', slug: 'docs', template: 'listing', status: 'published', blocks: [{ id: 'aaaaaaaa-1111-4111-8111-111111111111', type: 'hero', heading: 'Documentation', body: 'Browse the synthetic documentation.', cta: { label: 'Read guide', href: '/docs/guide' }, hidden: false, appearance }] },
    { id: pillarId, sectionId: section.id, parentId: listingId, title: `${name} guide`, summary: 'A synthetic guide.', slug: 'guide', template: 'pillar', status: 'published', blocks: [{ id: 'bbbbbbbb-1111-4111-8111-111111111111', type: 'featureGrid', heading: 'Guide topics', items: [{ title: 'Install', body: 'Install the synthetic example.' }], hidden: false, appearance }] },
    { id: serviceId, sectionId: section.id, parentId: pillarId, title: `${name} install`, summary: 'Synthetic installation service.', slug: 'install', template: 'service', status: 'published', blocks: [{ id: 'cccccccc-1111-4111-8111-111111111111', type: 'imageText', heading: 'Install safely', body: 'Use the synthetic package.', mediaId: snapshot.media[0].id, hidden: false, appearance }, { id: 'cccccccc-2222-4222-8222-222222222222', type: 'cta', heading: 'Continue', body: 'Continue through the guide.', cta: { label: 'Return to docs', href: '/docs' }, hidden: false, appearance }] },
    { id: articleId, sectionId: section.id, parentId: listingId, title: `${name} release notes`, summary: 'Synthetic release notes.', slug: 'release-notes', template: 'article', status: 'published', businessCase: { anonymizedClient: 'Synthetic client', industry: 'Synthetic services', challenge: 'A synthetic challenge.', approach: 'A synthetic approach.', outcome: 'A synthetic outcome.', services: ['Synthetic strategy'], publicationDate: '2026-10-05T12:00:00.000Z' }, blocks: [{ id: 'dddddddd-1111-4111-8111-111111111111', type: 'media', mediaId: snapshot.media[0].id, caption: 'Synthetic image caption.', hidden: false, appearance }, { id: 'dddddddd-2222-4222-8222-222222222222', type: 'video', mediaId: snapshot.media[2].id, posterMediaId: snapshot.media[1].id, captionsMediaId: snapshot.media[3].id, transcript: 'Synthetic transcript.', hidden: false, appearance }] },
    { id: draftId, sectionId: section.id, title: 'DRAFT_MARKER_MUST_NOT_RENDER', summary: 'Draft content.', slug: 'draft-marker', template: 'article', status: 'draft', blocks: [{ id: 'eeeeeeee-1111-4111-8111-111111111111', type: 'richText', body: 'DRAFT_MARKER_MUST_NOT_RENDER', hidden: false, appearance }] },
    { id: archiveId, sectionId: section.id, title: 'ARCHIVE_MARKER_MUST_NOT_RENDER', summary: 'Archived content.', slug: 'archive-marker', template: 'article', status: 'archived', blocks: [{ id: 'ffffffff-1111-4111-8111-111111111111', type: 'richText', body: 'ARCHIVE_MARKER_MUST_NOT_RENDER', hidden: false, appearance }] },
  );
  section.landingPageId = listingId;
  section.pageIds = snapshot.pages.map((page) => page.id);
  snapshot.pages.forEach((page, index) => {
    if (page.status === 'published') {
      page.publishedAt = `2026-10-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`;
      page.updatedAt = `2026-10-${String(index + 2).padStart(2, '0')}T12:00:00.000Z`;
    }
  });
  return snapshot;
}

async function writeSnapshot(root: string, snapshot: SiteSnapshot, filename = 'snapshot.json') {
  const input = join(root, filename);
  await writeFile(input, JSON.stringify(snapshot));
  return input;
}

async function customThemeComponents(root: string): Promise<string> {
  const components = await mkdtemp(join(root, 'custom-theme-components-'));
  await writeFile(join(components, 'theme.css'), 'body { outline: 1px solid #123456; }\n');
  await writeFile(join(components, 'Layout.astro'), `---
import './theme.css';
const { title, description } = Astro.props;
---
<!doctype html><html lang="en"><head><title>{title}</title><meta name="description" content={description} /></head><body data-custom-theme-layout="true"><main><slot /></main><script>document.documentElement.dataset.customThemeEnhancement = 'active';</script></body></html>\n`);
  await writeFile(join(components, 'BlockRenderer.astro'), `---
const { block } = Astro.props;
---
<section data-custom-theme-block={block.type}><h2>{block.heading ?? block.type}</h2></section>\n`);
  return components;
}

async function artifactContents(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? artifactContents(join(directory, entry.name)) : (await readFile(join(directory, entry.name))).toString('utf8')))).join('');
}

function staticServer(root: string, mount: string, headers: Record<string, string> = {}): Promise<{ server: Server; origin: string }> {
  const rootPath = resolve(root);
  const server = createServer(async (request, response) => {
    const requestPath = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const pathname = requestPath.startsWith(mount) ? `/${requestPath.slice(mount.length)}` : requestPath;
    const isPagePath = pathname.endsWith('/') || !pathname.split('/').at(-1)?.includes('.');
    const filePath = resolve(rootPath, `.${isPagePath ? `${pathname.replace(/\/$/, '')}/index.html` : pathname}`);
    if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${sep}`)) { response.writeHead(400).end(); return; }
    try { const body = await readFile(filePath); response.writeHead(200, { ...headers, 'content-type': filePath.endsWith('.js') ? 'text/javascript' : filePath.endsWith('.css') ? 'text/css' : filePath.endsWith('.avif') ? 'image/avif' : filePath.endsWith('.svg') ? 'image/svg+xml' : filePath.endsWith('.webm') ? 'video/webm' : filePath.endsWith('.vtt') ? 'text/vtt' : 'text/html' }); response.end(body); } catch { response.writeHead(404).end('Not found'); }
  });
  return new Promise((resolveServer) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.unref();
    resolveServer({ server, origin: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` });
  }));
}

describe('static snapshot renderer', () => {
  let root: string;
  let browserOutput: string;
  let server: Server | undefined;
  let serverOrigin = '';
  let priorAnalyticsEndpoint: string | undefined;
  let priorAnalyticsConsentRequired: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'site-snapshot-tests-'));
    priorAnalyticsEndpoint = process.env.PUBLIC_ANALYTICS_ENDPOINT;
    priorAnalyticsConsentRequired = process.env.PUBLIC_ANALYTICS_CONSENT_REQUIRED;
    delete process.env.PUBLIC_ANALYTICS_ENDPOINT;
    delete process.env.PUBLIC_ANALYTICS_CONSENT_REQUIRED;
    process.env.SITE_THEME_VERSION = '1.0.0';
    process.env.SITE_ENGINE_VERSION = '1.0.0';
  });
  afterAll(async () => {
    if (priorAnalyticsEndpoint === undefined) delete process.env.PUBLIC_ANALYTICS_ENDPOINT; else process.env.PUBLIC_ANALYTICS_ENDPOINT = priorAnalyticsEndpoint;
    if (priorAnalyticsConsentRequired === undefined) delete process.env.PUBLIC_ANALYTICS_CONSENT_REQUIRED; else process.env.PUBLIC_ANALYTICS_CONSENT_REQUIRED = priorAnalyticsConsentRequired;
    server?.closeAllConnections(); server?.close(); await rm(root, { recursive: true, force: true });
  });

  it('builds two concurrent, content-distinct snapshots without sharing Astro intermediates', async () => {
    const alpha = fixture('Alpha'); const beta = fixture('Beta');
    const alphaInput = await writeSnapshot(root, alpha, 'alpha.json'); const betaInput = await writeSnapshot(root, beta, 'beta.json');
    const priorMediaDirectory = process.env.SITE_MEDIA_DIR;
    process.env.SITE_MEDIA_DIR = await mkdtemp(join(root, 'empty-upload-source-'));
    const [alphaBuild, betaBuild] = await Promise.all([
      renderer.buildSnapshot({ input: alphaInput, publicOrigin: PUBLIC_ORIGIN, basePath: BASE_PATH, outputRoot: root, analytics: {} }),
      renderer.buildSnapshot({ input: betaInput, publicOrigin: PUBLIC_ORIGIN, basePath: BASE_PATH, outputRoot: root, analytics: {} }),
    ]);
    if (priorMediaDirectory === undefined) delete process.env.SITE_MEDIA_DIR; else process.env.SITE_MEDIA_DIR = priorMediaDirectory;
    expect(alphaBuild.manifest.snapshotContentHash).toBe(hash(alpha));
    expect(betaBuild.manifest.snapshotContentHash).toBe(hash(beta));
    expect(alphaBuild.manifest.snapshotContentHash).not.toBe(betaBuild.manifest.snapshotContentHash);
    expect(alphaBuild.manifest.sourceVersions).toEqual({ contractVersion: '1.0.0', themeVersion: '1.0.0', engineVersion: '1.0.0' });
    expect(Object.keys(alphaBuild.manifest.files)).toContain('index.html');
    expect(Object.values(alphaBuild.manifest.files)).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(await readFile(join(alphaBuild.output, 'snapshot-manifest.json'), 'utf8')).toContain(alphaBuild.manifest.snapshotContentHash);
    expect(await artifactContents(alphaBuild.output)).not.toContain('DRAFT_MARKER_MUST_NOT_RENDER');
    expect(await artifactContents(alphaBuild.output)).not.toContain('ARCHIVE_MARKER_MUST_NOT_RENDER');
    expect(await artifactContents(alphaBuild.output)).not.toContain('Motion fixture');
    expect(await artifactContents(alphaBuild.output)).not.toContain('Synthetic content for public engine validation.');
    expect(Object.keys(alphaBuild.manifest.files)).not.toEqual(expect.arrayContaining(['motion/one/index.html', 'motion/two/index.html']));
    expect(await readdir(alphaBuild.output)).not.toContain('input.json');
    const html = await readFile(join(alphaBuild.output, 'index.html'), 'utf8');
    // Private previews use strict CSP: stylesheet rules must be same-origin files.
    expect(html).not.toMatch(/<style(?:\s|>)/i);
    expect(html).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="\/preview\//);
    expect(html).not.toContain('>Search<');
    expect(html).not.toContain('hero__support');
    expect(html).not.toContain('data-secondary-cta');
    expect(Object.keys(alphaBuild.manifest.files).some(path => path.endsWith('.css'))).toBe(true);
    const missingPage = await readFile(join(alphaBuild.output, '404.html'), 'utf8');
    expect(missingPage).toContain(alpha.settings.siteName);
    expect(missingPage).toContain(`${BASE_PATH}docs/release-notes`);
    expect(missingPage).toContain(`href="${BASE_PATH}"`);
    expect(missingPage).not.toContain('/general/gallery');
    expect(missingPage).not.toContain('>Search<');
    expect(missingPage).toContain('noindex, nofollow, noarchive');
    browserOutput = alphaBuild.output;
  }, 180_000);

  it('emits public-only SEO, crawler, schema, and machine-readable outputs', async () => {
    const sitemap = await readFile(join(browserOutput, 'sitemap.xml'), 'utf8');
    const robots = await readFile(join(browserOutput, 'robots.txt'), 'utf8');
    const llms = await readFile(join(browserOutput, 'llms.txt'), 'utf8');
    const machine = JSON.parse(await readFile(join(browserOutput, 'machine-readable.json'), 'utf8'));
    const article = await readFile(join(browserOutput, 'docs/release-notes/index.html'), 'utf8');
    const listing = await readFile(join(browserOutput, 'docs/index.html'), 'utf8');
    const pillar = await readFile(join(browserOutput, 'docs/guide/index.html'), 'utf8');
    const service = await readFile(join(browserOutput, 'docs/guide/install/index.html'), 'utf8');
    expect(sitemap).toContain('<lastmod>2026-10-05T12:00:00.000Z</lastmod>');
    expect(sitemap).toContain('<loc>https://public.example.test/docs/release-notes</loc>');
    expect(sitemap).not.toContain('draft-marker');
    expect(robots).toContain('Disallow: /');
    expect(robots).toContain('crawler policy 2026-10-03');
    expect(llms).toContain('[Alpha release notes](https://public.example.test/docs/release-notes)');
    expect(llms).not.toContain('DRAFT_MARKER_MUST_NOT_RENDER');
    expect(machine.pages.map((page: { url: string }) => page.url)).not.toContain('https://public.example.test/docs/draft-marker');
    expect(JSON.stringify(machine)).not.toContain('DRAFT_MARKER_MUST_NOT_RENDER');
    expect(JSON.stringify(machine)).not.toContain('"id"');
    expect(JSON.stringify(machine)).not.toContain('"sectionId"');
    expect(JSON.stringify(machine)).not.toContain('"parentId"');
    expect(listing).toContain('>Pages</h2>');
    expect(pillar).toContain('>Child pages</h2>');
    expect(pillar).toContain('Alpha install');
    expect(service).not.toContain('>Child pages</h2>');
    expect(service).not.toContain('No child pages are published.');
    expect(article).toContain('application/ld+json');
    expect(article).toContain('"@type":"Article"');
    expect(article).toContain('"@type":"BreadcrumbList"');
    expect(article).toContain('"@type":"ProfessionalService"');
    expect(article).toContain('Synthetic client');
    expect(article).toContain('Synthetic strategy');
    expect(article).toContain('"keywords":"Synthetic strategy"');
  });

  it('does not embed analytics collection without an explicitly configured endpoint', async () => {
    expect(await readFile(join(browserOutput, 'index.html'), 'utf8')).not.toContain('site-analytics-consent');
  });

  it('keeps search unavailable until an Owner-reviewed setting enables it', async () => {
    const snapshot = fixture('Search disabled');
    snapshot.settings.searchEnabled = false;
    const built = await renderer.buildSnapshot({ input: await writeSnapshot(root, snapshot, 'search-disabled.json'), publicOrigin: PUBLIC_ORIGIN, outputRoot: root });
    const served = await staticServer(built.output, '/');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${served.origin}/`, { waitUntil: 'domcontentloaded' });
      expect(await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Search', exact: true }).count()).toBe(0);
      await page.goto(`${served.origin}/search`, { waitUntil: 'domcontentloaded' });
      expect(await page.getByRole('status').textContent()).toContain('Search is unavailable for this site.');
      expect(await page.getByRole('search').count()).toBe(0);
      expect(await page.locator('meta[name="robots"]').getAttribute('content')).toBe('noindex, nofollow, noarchive');
      const index = await page.request.get(`${served.origin}/search-index.json`);
      expect(index.ok()).toBe(true);
      await expect(index.json()).resolves.toEqual({ version: 1, documents: [] });
    } finally {
      served.server.closeAllConnections();
      served.server.close();
      await browser.close();
    }
  }, 120_000);

  it('ENG-002 ENG-005 renders optional hero actions and supporting information accessibly at desktop and mobile widths', async () => {
    const snapshot = fixture('Hero supporting content');
    const hero = snapshot.pages[0]!.blocks[0]!;
    if (hero.type !== 'hero') throw new Error('Fixture must begin with a hero.');
    snapshot.settings.contractVersion = '1.2.0';
    hero.anchorId = 'overview';
    hero.secondaryCta = { label: 'Compare options', href: '/docs' };
    hero.phoneCta = { label: 'Call urgent support', number: '+15551234567' };
    hero.supportPanel = { eyebrow: 'Helpful context', heading: 'Before you begin', body: 'Review this neutral supporting information before continuing. <img id="hero-injected" src=x onerror=alert(1)>', cta: { label: 'Read details', href: '/docs' }, phoneCta: { label: 'Call the team', number: '+15551234567' } };
    snapshot.pages[0]!.blocks.push({ id: 'abababab-abab-4bab-8bab-abababababab', type: 'pillarGrid', eyebrow: 'Optional context', heading: 'Helpful services', body: 'Neutral introduction copy.', items: [{ title: 'Service', body: 'A neutral service detail.', href: '/docs', links: [{ label: 'Back to overview', href: '/#overview' }] }], hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } } as never);
    const built = await renderer.buildSnapshot({ input: await writeSnapshot(root, snapshot, 'hero-supporting-content.json'), publicOrigin: PUBLIC_ORIGIN, outputRoot: root });
    const served = await staticServer(built.output, '/');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${served.origin}/`, { waitUntil: 'networkidle' });
      expect(await page.locator('[data-primary-cta]').count()).toBe(1);
      expect(await page.locator('[data-secondary-cta]').count()).toBe(1);
      expect(await page.getByRole('link', { name: 'Compare options' }).getAttribute('href')).toBe('/docs');
      expect(await page.getByRole('link', { name: 'Call urgent support' }).getAttribute('href')).toBe('tel:+15551234567');
      expect(await page.getByRole('link', { name: 'Back to overview' }).getAttribute('href')).toBe('/#overview');
      const support = page.getByRole('complementary', { name: 'Before you begin' });
      expect(await support.textContent()).toContain('Review this neutral supporting information');
      expect(await page.locator('#hero-injected').count()).toBe(0);
      expect(await support.getByRole('link', { name: 'Read details' }).getAttribute('href')).toBe('/docs');
      expect(await support.getByRole('link', { name: 'Call the team' }).getAttribute('href')).toBe('tel:+15551234567');
      await page.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.locator('.hero--with-panel').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(width === 1280 ? 2 : 1);
        const violations = await page.evaluate(async () => {
          const axe = (window as typeof window & { axe: { run: (context: string, options: unknown) => Promise<{ violations: unknown[] }> } }).axe;
          return (await axe.run('.hero', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations;
        });
        expect(violations).toEqual([]);
      }
    } finally { served.server.closeAllConnections(); served.server.close(); await browser.close(); }
  }, 120_000);

  it('composes service page metadata into one hero and generates one header when no hero exists', async () => {
    const snapshot = fixture('Service metadata');
    snapshot.settings.contractVersion = '1.4.0';
    const service = snapshot.pages.find((page) => page.template === 'service')!;
    service.kicker = 'Advisory';
    service.lede = 'A persisted service introduction.';
    service.lastReviewed = '2026-10-01T00:00:00.000Z';
    service.blocks.unshift({ id: 'cccccccc-0000-4000-8000-000000000001', type: 'hero', heading: 'Stored hero heading', body: 'Stored hero body.', cta: { label: 'Preserved action', href: '/docs' }, hidden: false, appearance: { background: 'accent', width: 'wide', spacing: 'spacious', motionIntent: 'none', logoTone: 'default' } });
    const withoutHero = { ...structuredClone(service), id: 'cccccccc-0000-4000-8000-000000000002', slug: 'without-hero', title: 'Service without hero', kicker: 'Planning', lede: 'A generated service introduction.', blocks: service.blocks.filter((block) => block.type !== 'hero') };
    snapshot.pages.push(withoutHero);
    snapshot.settings.sections[0]!.pageIds.push(withoutHero.id);
    const built = await renderer.buildSnapshot({ input: await writeSnapshot(root, snapshot, 'service-metadata.json'), publicOrigin: PUBLIC_ORIGIN, outputRoot: root });
    const withHero = await readFile(join(built.output, 'docs/guide/install/index.html'), 'utf8');
    const generated = await readFile(join(built.output, 'docs/guide/without-hero/index.html'), 'utf8');
    expect(withHero.match(/<h1(?:\s|>)/g)).toHaveLength(1);
    expect(withHero).toContain('Service metadata install');
    expect(withHero).toContain('A persisted service introduction.');
    expect(withHero).toContain('Preserved action');
    expect(withHero).toContain('block--accent');
    expect(withHero).toContain('Last reviewed');
    expect(generated.match(/<h1(?:\s|>)/g)).toHaveLength(1);
    expect(generated).toContain('Service without hero');
    expect(generated).toContain('A generated service introduction.');
  }, 120_000);

  it('renders trusted custom components inside the generic host without losing core outputs or parallel isolation', async () => {
    const customComponents = await customThemeComponents(root);
    const custom = fixture('Custom theme host'); custom.settings.contractVersion = '1.5.0'; custom.settings.searchEnabled = true; const defaultSnapshot = fixture('Default theme host');
    const section = custom.settings.sections[0]!;
    const jobID = '12121212-1212-4212-8212-121212121212';
    const inquiryID = '13131313-1313-4313-8313-131313131313';
    section.allowedTemplates.push('standard', 'job'); section.pageIds.push(inquiryID, jobID);
    custom.pages.push({ id: inquiryID, sectionId: section.id, parentId: custom.pages.find((page) => page.slug === 'docs')!.id, title: 'Custom theme inquiry', summary: 'A host-owned inquiry form.', slug: 'custom-theme-inquiry', template: 'standard', status: 'published', blocks: [{ id: '14141414-1414-4414-8414-141414141414', type: 'contact', heading: 'Custom theme inquiry', body: 'The generic host owns this form.', inquiryForm: true, inquiryTopicLabel: 'Inquiry reason', inquiryTopics: [{ value: 'consultation', label: 'Synthetic consultation' }, { value: 'active-incident', label: 'Synthetic incident' }, { value: 'service', label: 'Synthetic service' }], inquiryConsentLabel: 'I agree that the organization may respond to this inquiry.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] });
    custom.pages.push({ id: jobID, sectionId: section.id, parentId: custom.pages.find((page) => page.slug === 'docs')!.id, title: 'Custom theme job', summary: 'A job rendered by the generic host.', slug: 'custom-theme-job', template: 'job', status: 'published', blocks: [], jobPosting: { datePosted: '2026-10-01T12:00:00.000Z', employmentType: 'FULL_TIME', location: { addressLocality: 'Example City', addressCountry: 'CA' } } });
    const [customBuild, customPreviewBuild, defaultBuild] = await Promise.all([
      renderer.buildSnapshot({ input: await writeSnapshot(root, custom, 'custom-theme.json'), publicOrigin: PUBLIC_ORIGIN, basePath: '/', outputRoot: root, themeComponentsRoot: customComponents }),
      renderer.buildSnapshot({ input: await writeSnapshot(root, custom, 'custom-theme-preview.json'), publicOrigin: PUBLIC_ORIGIN, basePath: BASE_PATH, outputRoot: root, themeComponentsRoot: customComponents }),
      renderer.buildSnapshot({ input: await writeSnapshot(root, defaultSnapshot, 'default-theme.json'), publicOrigin: PUBLIC_ORIGIN, basePath: BASE_PATH, outputRoot: root }),
    ]);
    expect(await readFile(join(customBuild.output, 'index.html'), 'utf8')).toContain('data-custom-theme-layout="true"');
    expect(await readFile(join(customBuild.output, 'index.html'), 'utf8')).toMatch(/<script\b/i);
    expect(await readFile(join(customPreviewBuild.output, 'index.html'), 'utf8')).toMatch(/<script[^>]+src=/i);
    expect(await readFile(join(defaultBuild.output, 'index.html'), 'utf8')).not.toContain('data-custom-theme-layout="true"');
    expect(await readFile(join(customBuild.output, 'search-index.json'), 'utf8')).toContain('Custom theme host home');
    expect(await readFile(join(customBuild.output, 'machine-readable.json'), 'utf8')).toContain('Custom theme host home');
    expect(await readFile(join(customBuild.output, 'sitemap.xml'), 'utf8')).toContain('custom-theme-job');
    expect(await readFile(join(customBuild.output, 'docs/custom-theme-job/index.html'), 'utf8')).toContain('data-application-form');
    expect(await readFile(join(customComponents, 'BlockRenderer.astro'), 'utf8')).not.toContain('data-inquiry-form');
    const browser = await chromium.launch(); const publicServer = await staticServer(customBuild.output, '/'); const previewServer = await staticServer(customPreviewBuild.output, BASE_PATH, { 'content-security-policy': "default-src 'self'" });
    try {
      const publicPage = await browser.newPage(); const publicSubmissions: Record<string, unknown>[] = [];
      await publicPage.route('**/api/inquiries', async (route) => { publicSubmissions.push(route.request().postDataJSON()); await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: true }) }); });
      await publicPage.goto(`${publicServer.origin}/docs/custom-theme-inquiry/`, { waitUntil: 'networkidle' });
      expect(await publicPage.locator('html').getAttribute('data-custom-theme-enhancement')).toBe('active');
      await publicPage.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
      for (const width of [1280, 390]) {
        await publicPage.setViewportSize({ width, height: 900 });
        const violations = await publicPage.evaluate(async () => {
          const axe = (window as typeof window & { axe: { run: (context: string, options: unknown) => Promise<{ violations: unknown[] }> } }).axe;
          return (await axe.run('nav[aria-label="Breadcrumb"]', { runOnly: { type: 'rule', values: ['target-size'] } })).violations;
        });
        expect(violations).toEqual([]);
      }
      expect(await publicPage.locator('[data-inquiry-form]').count()).toBe(1);
      expect(await publicPage.locator('[data-inquiry-heading]').count()).toBe(0);
      expect(await publicPage.locator('[data-custom-theme-block="contact"], [data-inquiry-form]').evaluateAll((nodes) => nodes.map((node) => node.matches('[data-custom-theme-block="contact"]') ? 'contact' : 'form'))).toEqual(['contact', 'form']);
      expect(await publicPage.getByLabel('Inquiry reason').locator('option').allTextContents()).toEqual(['Synthetic consultation', 'Synthetic incident', 'Synthetic service']);
      await publicPage.getByLabel('Name').fill('Custom theme visitor');
      await publicPage.getByLabel('Work email').fill('custom-theme@example.test');
      await publicPage.getByLabel('Inquiry reason').selectOption('service');
      await publicPage.getByLabel('Message').fill('A synthetic inquiry for the custom theme.');
      await publicPage.getByLabel(/I agree that the organization/).check();
      await publicPage.getByRole('button', { name: 'Send inquiry' }).click();
      await publicPage.getByRole('status').filter({ hasText: 'received' }).waitFor();
      expect(publicSubmissions).toHaveLength(1);
      expect(publicSubmissions[0]).toMatchObject({ topic: 'service', consent: true, sourcePage: '/docs/custom-theme-inquiry/' });
      const previewPage = await browser.newPage(); let previewSubmissions = 0; const cspErrors: string[] = [];
      previewPage.on('console', (message) => { if (message.type() === 'error') cspErrors.push(message.text()); });
      await previewPage.route('**/api/inquiries', async (request) => { previewSubmissions += 1; await request.abort(); });
      await previewPage.goto(`${previewServer.origin}${BASE_PATH}docs/custom-theme-inquiry/`, { waitUntil: 'networkidle' });
      const previewForm = previewPage.locator('[data-inquiry-form]');
      expect(await previewForm.count()).toBe(1);
      expect(await previewPage.getByRole('button', { name: 'Send inquiry' }).isDisabled()).toBe(true);
      await previewForm.evaluate((form: HTMLFormElement) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      await previewPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(previewSubmissions).toBe(0);
      expect(await previewPage.locator('html').getAttribute('data-custom-theme-enhancement')).toBe('active');
      expect(cspErrors.filter((message) => /content security policy|inline script/i.test(message))).toEqual([]);
    } finally { publicServer.server.closeAllConnections(); publicServer.server.close(); previewServer.server.closeAllConnections(); previewServer.server.close(); await browser.close(); }
  }, 180_000);

  it('rejects component roots that are non-absolute, symbolic, or missing the required renderer contract', async () => {
    const input = await writeSnapshot(root, fixture('Unsafe components'), 'unsafe-components.json');
    const components = await customThemeComponents(root);
    const missing = join(root, 'missing-components'); await mkdir(missing); await writeFile(join(missing, 'Layout.astro'), '<slot />');
    const linked = join(root, 'linked-components'); await symlink(components, linked, 'dir');
    await expect(renderer.buildSnapshot({ input, publicOrigin: PUBLIC_ORIGIN, outputRoot: root, themeComponentsRoot: 'relative-components' })).rejects.toThrow('absolute normalized');
    await expect(renderer.buildSnapshot({ input, publicOrigin: PUBLIC_ORIGIN, outputRoot: root, themeComponentsRoot: `${components}/../${components.split('/').at(-1)}` })).rejects.toThrow('absolute normalized');
    await expect(renderer.buildSnapshot({ input, publicOrigin: PUBLIC_ORIGIN, outputRoot: root, themeComponentsRoot: linked })).rejects.toThrow('real directory');
    await expect(renderer.buildSnapshot({ input, publicOrigin: PUBLIC_ORIGIN, outputRoot: root, themeComponentsRoot: missing })).rejects.toThrow('missing required BlockRenderer.astro');
  });

  it('hosts consent hooks outside custom theme layouts and excludes them from private previews', async () => {
    const components = await customThemeComponents(root); const input = await writeSnapshot(root, fixture('Analytics custom theme'), 'analytics-custom.json');
    const analytics = { endpoint: 'https://analytics.example.test/events' };
    const publicBuild = await renderer.buildSnapshot({ input, publicOrigin: PUBLIC_ORIGIN, outputRoot: root, themeComponentsRoot: components, analytics });
    const previewBuild = await renderer.buildSnapshot({ input, publicOrigin: PUBLIC_ORIGIN, basePath: BASE_PATH, outputRoot: root, themeComponentsRoot: components, analytics });
    const publicHTML = await readFile(join(publicBuild.output, 'index.html'), 'utf8');
    expect(publicHTML).toContain('data-custom-theme-layout="true"'); expect(publicHTML).toContain('data-analytics-consent'); expect(publicHTML).toMatch(/<script[^>]+type="module"/);
    expect(await readFile(join(previewBuild.output, 'index.html'), 'utf8')).not.toContain('data-analytics-consent');
  }, 120_000);

  it('emits a deterministic, one-hop Nginx redirect include from the approved snapshot', async () => {
    const snapshot = fixture('Redirect rules')
    snapshot.redirects = [{ from: '/legacy/', to: '/docs', status: 301 }]
    // Snapshot contract data is normalized before build artifacts are produced.
    snapshot.redirects[0]!.from = '/legacy'
    const built = await renderer.buildSnapshot({ input: await writeSnapshot(root, snapshot, 'redirects.json'), publicOrigin: PUBLIC_ORIGIN, basePath: BASE_PATH, outputRoot: root })
    const rules = await readFile(join(built.output, 'redirects.nginx.conf'), 'utf8')
    expect(rules).toBe('# Generated from an approved immutable snapshot. Do not edit.\nlocation = /legacy { return 301 /docs; }\n')
    expect(built.manifest.files).toHaveProperty('redirects.nginx.conf')
  }, 60_000);

  it('escapes structured data and displays the same job metadata described by its schema', async () => {
    const snapshot = fixture('Safe metadata');
    const attack = '</script><img id="injected" src=x onerror=alert(1)>';
    snapshot.pages[0]!.title = attack;
    const section = snapshot.settings.sections[0]!;
    section.allowedTemplates.push('job');
    const jobId = '12345678-1234-4234-8234-123456789abc';
    section.pageIds.push(jobId);
    snapshot.pages.push({ id: jobId, sectionId: section.id, parentId: section.landingPageId,
      title: 'Example role', summary: 'Synthetic role details.', slug: 'safe-role', template: 'job', status: 'published',
      blocks: [{ id: '12345678-1234-4234-8234-123456789abd', type: 'richText', body: 'A complete visible synthetic role description.', hidden: false,
        appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }],
      jobPosting: { datePosted: '2026-01-01T00:00:00.000Z', employmentType: 'FULL_TIME', location: { addressLocality: 'Example City', addressCountry: 'CA' }, validThrough: '2099-01-01T00:00:00.000Z' },
    });
    const built = await renderer.buildSnapshot({ input: await writeSnapshot(root, snapshot, 'safe-metadata.json'), publicOrigin: PUBLIC_ORIGIN, basePath: BASE_PATH, outputRoot: root });
    const html = await readFile(join(built.output, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]![1]).not.toContain('<');
    expect(JSON.parse(scripts[0]![1]!)['@graph'].some((entry: { name?: string }) => entry.name === attack)).toBe(true);
    expect(html).not.toContain('<img id="injected"');
    const job = await readFile(join(built.output, 'docs/safe-role/index.html'), 'utf8');
    expect(job).toMatch(/<dt\b[^>]*>Location<\/dt><dd\b[^>]*>Example City, CA<\/dd>/);
    expect(job).toContain('full time');
    expect(job).toContain('"@type":"JobPosting"');
  }, 60_000);

  it('rejects malformed input and never promotes a partial artifact', async () => {
    const invalidJson = join(root, 'invalid.json'); const invalidSchema = join(root, 'invalid-schema.json');
    const promoted = (await readdir(root)).filter((name) => name.startsWith('snapshot-'));
    await writeFile(invalidJson, '{'); await writeFile(invalidSchema, JSON.stringify({ settings: {} }));
    await expect(renderer.buildSnapshot({ input: invalidJson, publicOrigin: PUBLIC_ORIGIN, outputRoot: root })).rejects.toThrow();
    await expect(renderer.buildSnapshot({ input: invalidSchema, publicOrigin: PUBLIC_ORIGIN, outputRoot: root })).rejects.toThrow();
    expect((await readdir(root)).filter((name) => name.startsWith('snapshot-'))).toEqual(promoted);
  });

  it('copies only referenced, checksummed media into an immutable artifact and rejects missing or corrupt sources before promotion', async () => {
    const source = await mkdtemp(join(tmpdir(), 'site-media-source-'));
    const previousMediaDirectory = process.env.SITE_MEDIA_DIR;
    try {
      for (const filename of ['sample-image.svg', 'sample-poster.svg', 'sample-video.webm', 'sample-captions.vtt']) await copyFile(join(process.cwd(), 'apps/site/public/media', filename), join(source, filename));
      const sharp = createRequire(new URL('../../cms/package.json', import.meta.url))('sharp');
      await writeFile(join(source, 'sample-image-hero.avif'), await sharp({ create: { width: 640, height: 360, channels: 3, background: '#155e75' } }).avif().toBuffer());
      await writeFile(join(source, 'unreferenced-private.txt'), 'must never enter artifact');
      process.env.SITE_MEDIA_DIR = source;
      const snapshot = fixture('Immutable media');
      snapshot.media = await Promise.all(snapshot.media.map(async (media) => ({ ...media, sha256: createHash('sha256').update(await readFile(join(source, media.filename))).digest('hex') })));
      const variant = await readFile(join(source, 'sample-image-hero.avif'));
      snapshot.media[0]!.variants = { heroAvif: { filename: 'sample-image-hero.avif', width: 640, height: 360, mimeType: 'image/avif', sha256: createHash('sha256').update(variant).digest('hex') } };
      const visibleMediaNames = snapshot.media.map((media) => media.filename);
      const privateMediaID = '99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      snapshot.media.push({ id: privateMediaID, filename: 'unreachable.svg', alt: 'Not publicly reachable', decorative: false, width: 640, height: 360, mimeType: 'image/svg+xml', sha256: 'f'.repeat(64) });
      const hiddenChild = structuredClone(snapshot.pages.find((page) => page.slug === 'install')!);
      hiddenChild.id = '99999999-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      hiddenChild.parentId = snapshot.pages.find((page) => page.status === 'draft')!.id;
      hiddenChild.slug = 'unreachable-child';
      hiddenChild.template = 'article';
      hiddenChild.blocks = [{ id: '99999999-cccc-4ccc-8ccc-cccccccccccc', type: 'media', mediaId: privateMediaID, hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }];
      snapshot.pages.push(hiddenChild);
      snapshot.settings.sections[0]!.pageIds.push(hiddenChild.id);
      const built = await renderer.buildSnapshot({ input: await writeSnapshot(root, snapshot, 'immutable-media.json'), publicOrigin: PUBLIC_ORIGIN, basePath: BASE_PATH, outputRoot: root });
      expect((await readdir(join(built.output, 'media'))).sort()).toEqual([...visibleMediaNames, 'sample-image-hero.avif'].sort());
      expect(await readFile(join(built.output, 'media/sample-image.svg'), 'utf8')).toContain('<svg');
      expect(await readFile(join(built.output, 'docs/guide/install/index.html'), 'utf8')).toContain(`${BASE_PATH}media/sample-image.svg`);
      expect(await readFile(join(built.output, 'docs/release-notes/index.html'), 'utf8')).toContain(`${BASE_PATH}media/sample-image.svg`);

      const served = await staticServer(built.output, BASE_PATH);
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(`${served.origin}${BASE_PATH}docs/release-notes/`, { waitUntil: 'networkidle' });
        const loaded = await page.locator('picture img').evaluate((image: HTMLImageElement) => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight, source: image.currentSrc }));
        expect(loaded.complete).toBe(true);
        expect(loaded.width).toBeGreaterThan(0);
        expect(loaded.height).toBeGreaterThan(0);
        expect(loaded.source).toBe(`${served.origin}${BASE_PATH}media/sample-image-hero.avif`);
      } finally { await browser.close(); served.server.closeAllConnections(); served.server.close(); }
      const promoted = (await readdir(root)).filter((name) => name.startsWith('snapshot-'));
      snapshot.media[0]!.sha256 = '0'.repeat(64);
      await expect(renderer.buildSnapshot({ input: await writeSnapshot(root, snapshot, 'corrupt-media.json'), publicOrigin: PUBLIC_ORIGIN, outputRoot: root })).rejects.toThrow('checksum mismatch');
      await rm(join(source, 'sample-image.svg'));
      await expect(renderer.buildSnapshot({ input: await writeSnapshot(root, snapshot, 'missing-media.json'), publicOrigin: PUBLIC_ORIGIN, outputRoot: root })).rejects.toThrow('unavailable');
      expect((await readdir(root)).filter((name) => name.startsWith('snapshot-'))).toEqual(promoted);
    } finally {
      if (previousMediaDirectory === undefined) delete process.env.SITE_MEDIA_DIR; else process.env.SITE_MEDIA_DIR = previousMediaDirectory;
      await rm(source, { recursive: true, force: true });
    }
  }, 120_000);

  it('renders focal crops from immutable full sources while retaining generated variants', async () => {
    const source = await mkdtemp(join(tmpdir(), 'site-focal-source-'));
    const previousMediaDirectory = process.env.SITE_MEDIA_DIR;
    const sharp = createRequire(new URL('../../cms/package.json', import.meta.url))('sharp');
    try {
      const fullSource = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#ef2929' } })
        .composite([{ input: { create: { width: 400, height: 150, channels: 3, background: '#2455e6' } }, left: 0, top: 150 }])
        .png().toBuffer();
      const generatedVariant = await sharp({ create: { width: 400, height: 225, channels: 3, background: '#168596' } }).avif().toBuffer();
      const responsiveVariant = await sharp(fullSource).webp().toBuffer();
      await writeFile(join(source, 'focal-source.png'), fullSource);
      await writeFile(join(source, 'focal-hero.avif'), generatedVariant);
      await writeFile(join(source, 'focal-hero.webp'), responsiveVariant);
      process.env.SITE_MEDIA_DIR = source;
      const snapshot = fixture('Focal crops');
      snapshot.settings.contractVersion = '1.4.0';
      const topID = snapshot.media[0]!.id;
      const bottomID = '11111111-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const identity = { filename: 'focal-source.png', sha256: createHash('sha256').update(fullSource).digest('hex'), variants: { heroAvif: { filename: 'focal-hero.avif', width: 400, height: 225, mimeType: 'image/avif' as const, sha256: createHash('sha256').update(generatedVariant).digest('hex') }, heroWebp: { filename: 'focal-hero.webp', width: 400, height: 300, mimeType: 'image/webp' as const, sha256: createHash('sha256').update(responsiveVariant).digest('hex') } }, alt: 'Two-color focal test image', decorative: false, width: 400, height: 300, mimeType: 'image/png' as const };
      snapshot.media[0] = { id: topID, ...identity, focalX: 50, focalY: 0 };
      snapshot.media.push({ id: bottomID, ...identity, focalX: 50, focalY: 100 });
      const article = snapshot.pages.find((page) => page.slug === 'release-notes')!;
      article.blocks = [
        { id: 'dddddddd-1111-4111-8111-111111111111', type: 'media', mediaId: topID, caption: 'Top focal crop', hidden: false, appearance: article.blocks[0]!.appearance },
        { id: 'dddddddd-3333-4333-8333-333333333333', type: 'media', mediaId: bottomID, caption: 'Bottom focal crop', hidden: false, appearance: article.blocks[0]!.appearance },
      ];
      const pillar = snapshot.pages.find((page) => page.slug === 'guide')!;
      pillar.blocks.push(
        { id: 'dddddddd-4444-4444-8444-444444444444', type: 'gallery', mediaIds: [topID, bottomID], hidden: false, appearance: pillar.blocks[0]!.appearance },
        { id: 'dddddddd-5555-4555-8555-555555555555', type: 'logoStrip', mediaIds: [topID], hidden: false, appearance: pillar.blocks[0]!.appearance },
      );
      const sourceHashBefore = createHash('sha256').update(await readFile(join(source, 'focal-source.png'))).digest('hex');
      const variantHashBefore = createHash('sha256').update(await readFile(join(source, 'focal-hero.avif'))).digest('hex');
      const responsiveHashBefore = createHash('sha256').update(await readFile(join(source, 'focal-hero.webp'))).digest('hex');
      const built = await renderer.buildSnapshot({ input: await writeSnapshot(root, snapshot, 'focal-crops.json'), publicOrigin: PUBLIC_ORIGIN, basePath: BASE_PATH, outputRoot: root });
      expect(createHash('sha256').update(await readFile(join(source, 'focal-source.png'))).digest('hex')).toBe(sourceHashBefore);
      expect(createHash('sha256').update(await readFile(join(source, 'focal-hero.avif'))).digest('hex')).toBe(variantHashBefore);
      expect(createHash('sha256').update(await readFile(join(source, 'focal-hero.webp'))).digest('hex')).toBe(responsiveHashBefore);
      expect(createHash('sha256').update(await readFile(join(built.output, 'media/focal-source.png'))).digest('hex')).toBe(sourceHashBefore);
      expect(createHash('sha256').update(await readFile(join(built.output, 'media/focal-hero.avif'))).digest('hex')).toBe(variantHashBefore);
      expect(createHash('sha256').update(await readFile(join(built.output, 'media/focal-hero.webp'))).digest('hex')).toBe(responsiveHashBefore);
      const served = await staticServer(built.output, BASE_PATH);
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
        await page.goto(`${served.origin}${BASE_PATH}docs/release-notes/`, { waitUntil: 'networkidle' });
        const wide = page.locator('.media-frame--wide');
        expect(await wide.count()).toBe(2);
        for (const frame of await wide.all()) {
          const box = await frame.boundingBox();
          expect(box && box.width / box.height).toBeCloseTo(16 / 9, 1);
          expect(await frame.locator('source').count()).toBe(1);
          expect(await frame.locator('img').evaluate((image: HTMLImageElement) => image.currentSrc.endsWith('/media/focal-hero.webp') && getComputedStyle(image).objectFit === 'cover')).toBe(true);
        }
        const center = async (index: number) => {
          const { data, info } = await sharp(await wide.nth(index).locator('img').screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
          const offset = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
          return [data[offset], data[offset + 1], data[offset + 2]];
        };
        const top = await center(0); const bottom = await center(1);
        expect(top[0]).toBeGreaterThan(top[2]);
        expect(bottom[2]).toBeGreaterThan(bottom[0]);
        await page.goto(`${served.origin}${BASE_PATH}docs/guide/`, { waitUntil: 'networkidle' });
        const squares = page.locator('.media-frame--square');
        expect(await squares.count()).toBe(2);
        const squareBox = await squares.first().boundingBox();
        expect(squareBox && squareBox.width / squareBox.height).toBeCloseTo(1, 1);
        const logo = page.locator('.logo-media').first();
        expect(await logo.locator('img').evaluate((image: HTMLImageElement) => getComputedStyle(image).objectFit)).toBe('contain');
        await page.goto(`${served.origin}${BASE_PATH}docs/guide/install/`, { waitUntil: 'networkidle' });
        const portrait = page.locator('.media-frame--portrait'); const portraitBox = await portrait.boundingBox();
        expect(portraitBox && portraitBox.width / portraitBox.height).toBeCloseTo(4 / 5, 1);
        expect(await portrait.locator('img').evaluate((image: HTMLImageElement) => image.currentSrc.endsWith('/media/focal-source.png'))).toBe(true);
      } finally { await browser.close(); served.server.closeAllConnections(); served.server.close(); }
    } finally {
      if (previousMediaDirectory === undefined) delete process.env.SITE_MEDIA_DIR; else process.env.SITE_MEDIA_DIR = previousMediaDirectory;
      await rm(source, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects unsafe preview bases and public origins before promoting an artifact', async () => {
    const input = await writeSnapshot(root, fixture('Unsafe config'), 'unsafe-config.json');
    const promoted = (await readdir(root)).filter((name) => name.startsWith('snapshot-'));
    for (const basePath of ['relative', '/preview/../escape/', '/preview/%2e%2e/escape/', '/preview\\escape/', '/preview?query', '//preview/']) {
      await expect(renderer.buildSnapshot({ input, publicOrigin: PUBLIC_ORIGIN, basePath, outputRoot: root })).rejects.toThrow();
    }
    for (const publicOrigin of ['ftp://public.example.test', 'https://user@public.example.test', 'https://public.example.test/path', 'https://public.example.test?query', 'https://public.example.test#fragment']) {
      await expect(renderer.buildSnapshot({ input, publicOrigin, basePath: BASE_PATH, outputRoot: root })).rejects.toThrow();
    }
    expect((await readdir(root)).filter((name) => name.startsWith('snapshot-'))).toEqual(promoted);
  });

  it('uses the frozen input even if the source file changes during Astro build', async () => {
    const frozen = fixture('Frozen source'); const mutated = fixture('Mutated source');
    const input = await writeSnapshot(root, frozen, 'frozen.json');
    const existing = new Set(await readdir(root));
    const pending = renderer.buildSnapshot({ input, publicOrigin: PUBLIC_ORIGIN, basePath: BASE_PATH, outputRoot: root });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const staging = (await readdir(root)).find((name) => name.startsWith('.snapshot-staging-') && !existing.has(name));
      if (staging) {
        try { await readFile(join(root, staging, 'input.json'), 'utf8'); break; } catch { /* the input is being written */ }
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    await writeFile(input, JSON.stringify(mutated));
    const built = await pending;
    expect(built.manifest.snapshotContentHash).toBe(hash(frozen));
    expect(await artifactContents(built.output)).toContain('Frozen source home heading');
    expect(await artifactContents(built.output)).not.toContain('Mutated source home heading');
    expect(await artifactContents(built.output)).not.toContain('input.json');
  }, 180_000);

  it('rejects symlinked output roots and keeps every emitted path inside the artifact', async () => {
    const target = await mkdtemp(join(tmpdir(), 'site-snapshot-target-'));
    const link = join(root, 'linked-output');
    await symlink(target, link, 'dir');
    await expect(renderer.buildSnapshot({ input: await writeSnapshot(root, fixture('Link')), publicOrigin: PUBLIC_ORIGIN, outputRoot: link })).rejects.toThrow('outputRoot must be a real directory');
    const artifactFiles = Object.keys(JSON.parse(await readFile(join(browserOutput, 'snapshot-manifest.json'), 'utf8')).files);
    for (const file of artifactFiles) {
      expect(normalize(file)).not.toMatch(/^(?:\.\.(?:[\\/]|$)|[\\/])/);
      expect((await lstat(join(browserOutput, file))).isSymbolicLink()).toBe(false);
    }
    await rm(target, { recursive: true, force: true });
  });

  it('terminates a timed-out Astro process before it can promote an artifact', async () => {
    const input = await writeSnapshot(root, fixture('Timeout'), 'timeout.json');
    const before = new Set(await readdir(root));
    await expect(renderer.buildSnapshot({ input, publicOrigin: PUBLIC_ORIGIN, basePath: BASE_PATH, outputRoot: root, timeoutMs: 1 })).rejects.toThrow('timed out');
    await new Promise((done) => setTimeout(done, 100));
    const after = await readdir(root);
    expect(after.filter((name) => name.startsWith('snapshot-'))).toEqual([...before].filter((name) => name.startsWith('snapshot-')));
    expect(after.filter((name) => name.startsWith('.snapshot-staging-'))).toHaveLength(0);
  }, 30_000);

  it('crawls the generated preview in Chromium with prefix-safe links, assets, canonical URLs, and no-JS readability', async () => {
    const served = await staticServer(browserOutput, BASE_PATH); server = served.server; serverOrigin = served.origin;
    const browser = await chromium.launch();
    const context = await browser.newContext(); const page = await context.newPage();
    const paths = ['', 'docs/', 'docs/guide/', 'docs/guide/install/', 'docs/release-notes/'];
    for (const path of paths) {
      await page.goto(`${serverOrigin}${BASE_PATH}${path}`, { waitUntil: 'domcontentloaded', timeout: 5_000 });
      expect(await page.getByRole('heading').first().isVisible({ timeout: 5_000 })).toBe(true);
      expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe(path ? `${PUBLIC_ORIGIN}/${path.replace(/\/$/, '')}` : `${PUBLIC_ORIGIN}/`);
      expect(await page.locator('meta[name="robots"]').getAttribute('content')).toBe('noindex, nofollow, noarchive');
      const links = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href')));
      for (const href of links.filter((href): href is string => Boolean(href))) expect(/^(?:https?:|mailto:|tel:|#)/.test(href) || href.startsWith('/preview/changes/test/proposed/')).toBe(true);
    }
    await page.goto(`${serverOrigin}${BASE_PATH}docs/guide/install/`, { waitUntil: 'domcontentloaded', timeout: 5_000 });
    expect(await page.getByRole('link', { name: 'Return to docs' }).getAttribute('href')).toBe(`${BASE_PATH}docs`);
    expect(await page.locator('img').getAttribute('src')).toBe(`${BASE_PATH}media/sample-image.svg`);
    expect(await page.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    expect(await page.locator('picture source').count()).toBe(0);
    await page.getByRole('link', { name: 'Return to docs' }).click({ noWaitAfter: true }); await page.waitForURL(`${serverOrigin}${BASE_PATH}docs`, { timeout: 5_000 }); expect(page.url()).toBe(`${serverOrigin}${BASE_PATH}docs`);
    await page.goto(`${serverOrigin}${BASE_PATH}docs/release-notes/`, { waitUntil: 'domcontentloaded', timeout: 5_000 });
    expect(await page.getByRole('heading', { name: 'Case study' }).isVisible()).toBe(true);
    expect(await page.getByText('Synthetic client').isVisible()).toBe(true);
    const graph = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent()) ?? '{}') as { '@graph'?: Array<{ '@type'?: string; keywords?: string; contributor?: { name?: string } }> };
    const articleSchema = graph['@graph']?.find((entry) => entry['@type'] === 'Article');
    expect(articleSchema).toMatchObject({ keywords: 'Synthetic strategy', contributor: { name: 'Synthetic client' } });
    const noJs = await browser.newContext({ javaScriptEnabled: false }); const noJsPage = await noJs.newPage();
    await noJsPage.goto(`${serverOrigin}${BASE_PATH}docs/release-notes/`, { waitUntil: 'domcontentloaded', timeout: 5_000 });
    expect(await noJsPage.getByRole('heading').first().isVisible({ timeout: 5_000 })).toBe(true); expect(await noJsPage.locator('body').textContent()).toContain('Synthetic transcript.');
    await noJs.close(); await context.close(); await browser.close();
  }, 120_000);
  it('enables root inquiry forms, preserves retry keys, and prevents private preview submission', async () => {
    const snapshot = fixture('Inquiry');
    snapshot.settings.sections[0]!.allowedTemplates.push('standard');
    const inquiryPage = { ...snapshot.pages[0]!, id: '12345678-1234-4234-8234-123456789abf', template: 'standard' as const, slug: 'inquiry', blocks: [] as typeof snapshot.pages[0]['blocks'] };
    snapshot.pages.push(inquiryPage);
    snapshot.settings.sections[0]!.pageIds.push(inquiryPage.id);
    snapshot.settings.contractVersion = '1.3.0';
    inquiryPage.blocks.push({ id: '12345678-1234-4234-8234-123456789abe', type: 'contact', heading: 'Send a message', body: 'Synthetic inquiry form.', inquiryForm: true, contactDetails: { incidentCallout: { label: 'Urgent information', body: 'Use a listed contact method.' }, channels: [{ kind: 'link', label: 'Profile', value: 'Neutral profile', href: 'https://example.test/profile' }], nextStepsHeading: 'Next steps', nextSteps: [{ title: 'Review', body: 'We review each inquiry.' }] }, hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } });
    const input = await writeSnapshot(root, snapshot, 'inquiry.json');
    const browser = await chromium.launch();
    try {
      for (const basePath of ['/', BASE_PATH]) {
        const built = await renderer.buildSnapshot({ input, publicOrigin: PUBLIC_ORIGIN, basePath, outputRoot: root });
        const served = await staticServer(built.output, basePath);
        const context = await browser.newContext(); const page = await context.newPage();
        const submitted: Array<{ idempotencyKey: string; name: string; email: string; telephone: string; company: string }> = [];
        await page.route('**/api/inquiries', async route => {
          submitted.push(route.request().postDataJSON());
          if (submitted.length === 1) await route.abort('failed');
          else await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: true }) });
        });
        try {
          await page.goto(`${served.origin}${basePath}docs/inquiry/`, { waitUntil: 'networkidle' });
          const form = page.locator('[data-inquiry-form]'); const button = form.getByRole('button', { name: 'Send inquiry' });
          const headingId = '12345678-1234-4234-8234-123456789abe-inquiry-title';
          expect(await page.locator('[data-inquiry-form]').getAttribute('aria-labelledby')).toBe(headingId);
          expect(await page.locator(`[data-inquiry-heading][id="${headingId}"]`).count()).toBe(1);
          expect(await page.locator(`[data-inquiry-heading][id="${headingId}"]`).textContent()).toBe('Send a message');
          expect(await page.locator(`[id="${headingId}"]`).count()).toBe(1);
          expect(await page.locator('[data-inquiry-form], section[data-block="contact"]').evaluateAll((nodes) => nodes.map((node) => node.matches('[data-inquiry-form]') ? 'form' : 'details'))).toEqual(['form', 'details']);
          if (basePath === '/') {
            expect(await page.getByText('Urgent information', { exact: true }).isVisible()).toBe(true);
            expect(await page.getByRole('link', { name: 'Neutral profile' }).getAttribute('href')).toBe('https://example.test/profile');
            expect(await form.locator('[name="name"]').getAttribute('maxlength')).toBe('160');
            expect(await form.locator('[name="telephone"]').getAttribute('maxlength')).toBe('48');
            expect(await form.locator('[name="company"]').getAttribute('maxlength')).toBe('160');
            expect(await form.locator('[name="message"]').getAttribute('maxlength')).toBe('5000');
            expect(await form.locator('[name="message"]').getAttribute('rows')).toBe('5');
            await form.locator('[name="name"]').fill('Retry visitor');
            await form.locator('[name="email"]').fill('retry@example.test');
            await form.locator('[name="telephone"]').fill('+1 555 0123');
            await form.locator('[name="company"]').fill('Example Company');
            await form.locator('[name="message"]').fill('Please help with this inquiry.');
            await form.locator('[name="consent"]').check();
            expect(await button.isEnabled()).toBe(true);
            await button.click();
            await page.getByRole('alert').filter({ hasText: 'check your connection' }).waitFor();
            expect(await button.isEnabled()).toBe(true);
            await button.click();
            await page.getByRole('status').filter({ hasText: 'received' }).waitFor();
            expect(submitted).toHaveLength(2);
            expect(submitted[0]!.idempotencyKey).toBe(submitted[1]!.idempotencyKey);
            expect(submitted[0]).toMatchObject({ name: 'Retry visitor', email: 'retry@example.test', telephone: '+1 555 0123', company: 'Example Company' });
            expect(await button.isDisabled()).toBe(true);
          } else {
            expect(await button.isDisabled()).toBe(true);
            await page.locator('[data-inquiry-form]').evaluate((form: HTMLFormElement) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            expect(submitted).toHaveLength(0);
          }
        } finally { await context.close(); served.server.closeAllConnections(); served.server.close(); }
      }
    } finally { await browser.close(); }
  }, 120_000);

  it('gives multiple inquiry forms unique field-error IDs', async () => {
    const snapshot = fixture('Multiple inquiry forms'); snapshot.settings.sections[0]!.allowedTemplates.push('standard');
    const page = { ...snapshot.pages[0]!, id: '23232323-2323-4232-8232-232323232323', slug: 'multiple-inquiries', template: 'standard' as const, blocks: [
      { id: '24242424-2424-4242-8242-242424242424', type: 'contact' as const, heading: 'First inquiry', body: 'First neutral contact form.', inquiryForm: true, hidden: false, appearance: { background: 'default' as const, width: 'content' as const, spacing: 'default' as const, motionIntent: 'none' as const, logoTone: 'default' as const } },
      { id: '25252525-2525-4252-8252-252525252525', type: 'contact' as const, heading: 'Second inquiry', body: 'Second neutral contact form.', inquiryForm: true, hidden: false, appearance: { background: 'default' as const, width: 'content' as const, spacing: 'default' as const, motionIntent: 'none' as const, logoTone: 'default' as const } },
    ] };
    snapshot.pages.push(page); snapshot.settings.sections[0]!.pageIds.push(page.id);
    const built = await renderer.buildSnapshot({ input: await writeSnapshot(root, snapshot, 'multiple-inquiries.json'), publicOrigin: PUBLIC_ORIGIN, outputRoot: root });
    const html = await readFile(join(built.output, 'docs/multiple-inquiries/index.html'), 'utf8');
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(html).toContain('24242424-2424-4242-8242-242424242424-inquiry-name-error');
    expect(html).toContain('25252525-2525-4252-8252-252525252525-inquiry-name-error');
  });

  it('keeps analytics disabled until consent, sends allowlisted CTA, navigation, phone and form outcomes, and stops after revocation', async () => {
    const snapshot = fixture('Analytics'); snapshot.settings.sections[0]!.allowedTemplates.push('standard');
    const inquiry = { ...snapshot.pages[0]!, id: 'abababab-1234-4abc-8abc-abababababab', slug: 'analytics-inquiry', template: 'standard' as const, blocks: [{ id: 'abababab-2222-4abc-8abc-abababababab', type: 'contact' as const, heading: 'Contact', body: 'Synthetic analytics contact form.', inquiryForm: true, hidden: false, appearance: { background: 'default' as const, width: 'content' as const, spacing: 'default' as const, motionIntent: 'none' as const, logoTone: 'default' as const } }] };
    snapshot.pages.push(inquiry); snapshot.settings.sections[0]!.pageIds.push(inquiry.id);
    const input = await writeSnapshot(root, snapshot, 'analytics.json'); const built = await renderer.buildSnapshot({ input, publicOrigin: PUBLIC_ORIGIN, outputRoot: root, analytics: { endpoint: 'https://analytics.example.test/events' } }); const served = await staticServer(built.output, '/'); const browser = await chromium.launch(); const context = await browser.newContext(); const page = await context.newPage(); const events: unknown[] = [];
    let inquiries = 0;
    await page.route('https://analytics.example.test/events', async route => { events.push(route.request().postDataJSON()); await route.fulfill({ status: 204 }); }); await page.route('**/api/inquiries', async route => { inquiries += 1; await route.fulfill(inquiries === 1 ? { status: 422, contentType: 'application/json', body: JSON.stringify({ errors: { name: 'Enter a valid name.' } }) } : { status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: true }) }); });
    try {
      await page.goto(`${served.origin}/`); await page.locator('[data-primary-cta]').click(); expect(events).toEqual([]);
      await page.getByRole('button', { name: 'Allow optional measurement' }).click(); await expect.poll(() => events.some((item: any) => item.event === 'page_view')).toBe(true);
      await page.goto(`${served.origin}/docs/analytics-inquiry/?utm_source=search-test`);
      await page.getByLabel('Name').fill('Analytics visitor'); await page.getByLabel('Work email').fill('analytics@example.test'); await page.getByLabel('Message').fill('This must never be sent to analytics.'); await page.getByLabel(/I consent/).check();
      const submit = page.locator('[data-inquiry-form] button');
      await submit.click(); await page.getByRole('alert').filter({ hasText: 'Enter a valid name.' }).waitFor();
      expect(await page.getByLabel('Name').getAttribute('aria-invalid')).toBe('true'); expect(await page.locator('[data-inquiry-field-error="name"]').textContent()).toBe('Enter a valid name.');
      await submit.click(); await page.getByRole('status').filter({ hasText: 'received' }).waitFor();
      await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Home', exact: true }).click();
      await page.locator('[data-primary-cta]').click();
      await page.evaluate(() => { const phone = document.createElement('a'); phone.href = 'tel:+15550100'; phone.textContent = 'Call'; document.body.append(phone); });
      await page.locator('a[href="tel:+15550100"]').click({ noWaitAfter: true });
      await expect.poll(() => ['form_failed', 'form_accepted', 'navigation', 'primary_cta', 'phone_tap'].every(event => events.some((item: any) => item.event === event))).toBe(true);
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'page_view', attribution: 'search' }), expect.objectContaining({ event: 'form_failed', form: 'inquiry' }), expect.objectContaining({ event: 'form_accepted', form: 'inquiry' }), expect.objectContaining({ event: 'navigation' }), expect.objectContaining({ event: 'primary_cta' }), expect.objectContaining({ event: 'phone_tap' })])); expect(JSON.stringify(events)).not.toMatch(/message|email|This must never be sent|search-test/);
      const count = events.length;
      await page.getByRole('button', { name: 'Disable optional measurement' }).click();
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('site-conversion', { detail: { form: 'inquiry', accepted: false } })));
      await page.waitForTimeout(100); expect(events).toHaveLength(count);
    } finally { await context.close(); await browser.close(); served.server.closeAllConnections(); served.server.close(); }
  }, 120_000);

  it('keeps consent decisions effective for the current page when browser storage is unavailable', async () => {
    const snapshot = fixture('Analytics storage unavailable');
    const input = await writeSnapshot(root, snapshot, 'analytics-storage-unavailable.json');
    const browser = await chromium.launch();
    try {
      const optionalBuild = await renderer.buildSnapshot({ input, publicOrigin: PUBLIC_ORIGIN, outputRoot: root, analytics: { endpoint: 'https://analytics.example.test/events', consentRequired: false } });
      const optionalServer = await staticServer(optionalBuild.output, '/');
      const optionalContext = await browser.newContext();
      const optionalPage = await optionalContext.newPage();
      const optionalEvents: { event: string }[] = [];
      await optionalContext.addInitScript(() => {
        Object.defineProperty(Storage.prototype, 'getItem', { configurable: true, value: () => { throw new Error('storage disabled'); } });
        Object.defineProperty(Storage.prototype, 'setItem', { configurable: true, value: () => { throw new Error('storage disabled'); } });
      });
      await optionalPage.route('https://analytics.example.test/events', async route => { optionalEvents.push(route.request().postDataJSON()); await route.fulfill({ status: 204 }); });
      try {
        await optionalPage.goto(`${optionalServer.origin}/`, { waitUntil: 'networkidle' });
        await expect.poll(() => optionalEvents.filter(({ event }) => event === 'page_view')).toHaveLength(1);
        await optionalPage.getByRole('button', { name: 'Allow optional measurement' }).click();
        await optionalPage.waitForTimeout(100);
        expect(optionalEvents.filter(({ event }) => event === 'page_view')).toHaveLength(1);
        await optionalPage.getByRole('button', { name: 'Disable optional measurement' }).click();
        await optionalPage.locator('[data-primary-cta]').evaluate((link: HTMLAnchorElement) => {
          link.addEventListener('click', event => event.preventDefault(), { once: true });
          link.click();
        });
        await optionalPage.evaluate(() => window.dispatchEvent(new CustomEvent('site-conversion', { detail: { form: 'inquiry', accepted: true } })));
        await optionalPage.waitForTimeout(100);
        expect(optionalEvents.map(({ event }) => event)).toEqual(['page_view']);
      } finally {
        await optionalContext.close();
        optionalServer.server.closeAllConnections();
        optionalServer.server.close();
      }

      const requiredBuild = await renderer.buildSnapshot({ input, publicOrigin: PUBLIC_ORIGIN, outputRoot: root, analytics: { endpoint: 'https://analytics.example.test/events' } });
      const requiredServer = await staticServer(requiredBuild.output, '/');
      const requiredContext = await browser.newContext();
      const requiredPage = await requiredContext.newPage();
      const requiredEvents: { event: string }[] = [];
      await requiredContext.addInitScript(() => {
        Object.defineProperty(Storage.prototype, 'getItem', { configurable: true, value: () => { throw new Error('storage disabled'); } });
        Object.defineProperty(Storage.prototype, 'setItem', { configurable: true, value: () => { throw new Error('storage disabled'); } });
      });
      await requiredPage.route('https://analytics.example.test/events', async route => { requiredEvents.push(route.request().postDataJSON()); await route.fulfill({ status: 204 }); });
      try {
        await requiredPage.goto(`${requiredServer.origin}/`, { waitUntil: 'networkidle' });
        expect(requiredEvents).toEqual([]);
        await requiredPage.getByRole('button', { name: 'Allow optional measurement' }).click();
        await expect.poll(() => requiredEvents.filter(({ event }) => event === 'page_view')).toHaveLength(1);
        await requiredPage.getByRole('button', { name: 'Allow optional measurement' }).click();
        await requiredPage.waitForTimeout(100);
        expect(requiredEvents.filter(({ event }) => event === 'page_view')).toHaveLength(1);
        await requiredPage.getByRole('button', { name: 'Disable optional measurement' }).click();
        await requiredPage.evaluate(() => window.dispatchEvent(new CustomEvent('site-conversion', { detail: { form: 'inquiry', accepted: true } })));
        await requiredPage.waitForTimeout(100);
        expect(requiredEvents.map(({ event }) => event)).toEqual(['page_view']);
      } finally {
        await requiredContext.close();
        requiredServer.server.closeAllConnections();
        requiredServer.server.close();
      }
    } finally {
      await browser.close();
    }
  }, 120_000);

  it('renders application forms only as a disabled, non-enhanced control in private previews', async () => {
    const snapshot = fixture('Application preview');
    const section = snapshot.settings.sections[0]!;
    section.allowedTemplates.push('job');
    const job = { ...snapshot.pages[0]!, id: 'abababab-abab-4bab-8bab-abababababab', slug: 'application-role', title: 'Application preview role', template: 'job' as const, blocks: [] as typeof snapshot.pages[0]['blocks'], jobPosting: { datePosted: '2026-10-01T12:00:00.000Z', employmentType: 'FULL_TIME' as const, location: { addressLocality: 'Example City', addressCountry: 'CA' }, validThrough: '2099-01-01T00:00:00.000Z' } };
    snapshot.pages.push(job); section.pageIds.push(job.id);
    const input = await writeSnapshot(root, snapshot, 'application-preview.json');
    const browser = await chromium.launch();
    try {
      for (const basePath of ['/', BASE_PATH]) {
        const built = await renderer.buildSnapshot({ input, publicOrigin: PUBLIC_ORIGIN, basePath, outputRoot: root });
        const served = await staticServer(built.output, basePath);
        const context = await browser.newContext(); const page = await context.newPage(); let applications = 0; const retryKeys: string[] = [];
        await page.route('**/api/applications', async route => { applications += 1; const key = route.request().postDataBuffer()?.toString().match(/name="idempotencyKey"\r\n\r\n([^\r]+)/)?.[1]; if (key) retryKeys.push(key); if (applications < 3) await route.abort('failed'); else await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }) }); });
        try {
          await page.goto(`${served.origin}${basePath}docs/application-role/`, { waitUntil: 'networkidle' });
          const form = page.locator('[data-application-form]'); const button = page.getByRole('button', { name: 'Submit application' });
          if (basePath === '/') {
            expect(await button.isEnabled()).toBe(true);
            await page.getByLabel('Name').fill('Preview applicant'); await page.getByLabel('Email').fill('preview.applicant@example.test'); await page.getByLabel('Cover letter').fill('A valid public application form submission.');
            await page.getByLabel(/Resume/).setInputFiles({ name: 'resume.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\\npreview\\n%%EOF') }); await page.getByLabel(/I consent/).check(); await button.click();
            await page.getByRole('alert').waitFor({ state: 'visible' }); await button.click(); await page.getByRole('alert').waitFor({ state: 'visible' }); await page.getByLabel('Cover letter').fill('A changed public application submission.'); await button.click();
            await page.getByRole('status').filter({ hasText: 'Your application has been received.' }).waitFor({ state: 'visible' }); expect(await page.getByRole('status').textContent()).toBe('Your application has been received.'); expect(applications).toBe(3); expect(retryKeys).toHaveLength(3); expect(retryKeys[0]).toBe(retryKeys[1]); expect(retryKeys[2]).not.toBe(retryKeys[1]);
          } else {
            expect(await button.isDisabled()).toBe(true);
            await form.evaluate((element: HTMLFormElement) => element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
            expect(applications).toBe(0);
          }
        } finally { await context.close(); served.server.closeAllConnections(); served.server.close(); }
      }
    } finally { await browser.close(); }
  }, 120_000);

});
