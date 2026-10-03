import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
    { id: articleId, sectionId: section.id, parentId: listingId, title: `${name} release notes`, summary: 'Synthetic release notes.', slug: 'release-notes', template: 'article', status: 'published', blocks: [{ id: 'dddddddd-1111-4111-8111-111111111111', type: 'media', mediaId: snapshot.media[0].id, caption: 'Synthetic image caption.', hidden: false, appearance }, { id: 'dddddddd-2222-4222-8222-222222222222', type: 'video', mediaId: snapshot.media[2].id, posterMediaId: snapshot.media[1].id, captionsMediaId: snapshot.media[3].id, transcript: 'Synthetic transcript.', hidden: false, appearance }] },
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

async function artifactContents(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? artifactContents(join(directory, entry.name)) : (await readFile(join(directory, entry.name))).toString('utf8')))).join('');
}

function staticServer(root: string, mount: string): Promise<{ server: Server; origin: string }> {
  const rootPath = resolve(root);
  const server = createServer(async (request, response) => {
    const requestPath = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const pathname = requestPath.startsWith(mount) ? `/${requestPath.slice(mount.length)}` : requestPath;
    const isPagePath = pathname.endsWith('/') || !pathname.split('/').at(-1)?.includes('.');
    const filePath = resolve(rootPath, `.${isPagePath ? `${pathname.replace(/\/$/, '')}/index.html` : pathname}`);
    if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${sep}`)) { response.writeHead(400).end(); return; }
    try { const body = await readFile(filePath); response.writeHead(200); response.end(body); } catch { response.writeHead(404).end('Not found'); }
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

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'site-snapshot-tests-'));
    process.env.SITE_THEME_VERSION = '1.0.0';
    process.env.SITE_ENGINE_VERSION = '1.0.0';
  });
  afterAll(async () => { server?.closeAllConnections(); server?.close(); await rm(root, { recursive: true, force: true }); });

  it('builds two complete, content-distinct snapshots with CMS-compatible hashes', async () => {
    const alpha = fixture('Alpha'); const beta = fixture('Beta');
    const alphaInput = await writeSnapshot(root, alpha, 'alpha.json'); const betaInput = await writeSnapshot(root, beta, 'beta.json');
    const alphaBuild = await renderer.buildSnapshot({ input: alphaInput, publicOrigin: PUBLIC_ORIGIN, basePath: BASE_PATH, outputRoot: root });
    const betaBuild = await renderer.buildSnapshot({ input: betaInput, publicOrigin: PUBLIC_ORIGIN, basePath: BASE_PATH, outputRoot: root });
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
    expect(Object.keys(alphaBuild.manifest.files).some(path => path.endsWith('.css'))).toBe(true);
    browserOutput = alphaBuild.output;
  }, 180_000);

  it('emits public-only SEO, crawler, schema, and machine-readable outputs', async () => {
    const sitemap = await readFile(join(browserOutput, 'sitemap.xml'), 'utf8');
    const robots = await readFile(join(browserOutput, 'robots.txt'), 'utf8');
    const llms = await readFile(join(browserOutput, 'llms.txt'), 'utf8');
    const machine = JSON.parse(await readFile(join(browserOutput, 'machine-readable.json'), 'utf8'));
    const article = await readFile(join(browserOutput, 'docs/release-notes/index.html'), 'utf8');
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
    expect(article).toContain('application/ld+json');
    expect(article).toContain('"@type":"Article"');
    expect(article).toContain('"@type":"BreadcrumbList"');
    expect(article).toContain('"@type":"ProfessionalService"');
  });

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
    expect(job).toContain('<dt>Location</dt><dd>Example City, CA</dd>');
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
    await page.getByRole('link', { name: 'Return to docs' }).click({ noWaitAfter: true }); await page.waitForURL(`${serverOrigin}${BASE_PATH}docs`, { timeout: 5_000 }); expect(page.url()).toBe(`${serverOrigin}${BASE_PATH}docs`);
    const noJs = await browser.newContext({ javaScriptEnabled: false }); const noJsPage = await noJs.newPage();
    await noJsPage.goto(`${serverOrigin}${BASE_PATH}docs/release-notes/`, { waitUntil: 'domcontentloaded', timeout: 5_000 });
    expect(await noJsPage.getByRole('heading').first().isVisible({ timeout: 5_000 })).toBe(true); expect(await noJsPage.locator('body').textContent()).toContain('Synthetic transcript.');
    await noJs.close(); await context.close(); await browser.close();
  }, 120_000);
});
