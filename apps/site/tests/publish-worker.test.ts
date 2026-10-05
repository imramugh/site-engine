import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { neutralFixture } from '@site-engine/contract/fixtures';
import { createPublishAPI, runPublishOnce } from '../scripts/run-publish-worker.mjs';
import { createPublicServer } from '../scripts/public-server.mjs';
import { getInstalledTheme, parseThemeRegistry } from '../scripts/theme-registry.mjs';

const roots: string[] = []; const pins = { themeVersion: '1.0.0', engineVersion: '1.0.0', contractVersion: '1.0.0' };
const job = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', leaseToken: 'b'.repeat(36), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), sequence: 1 };
const themeManifest = { name: 'synthetic-theme', version: '1.0.0', contract: '1.0.0', entry: './dist/renderer.js', standardBlocks: ['hero', 'faq'], settingKeys: ['tone'], extensionBlocks: [], motion: { presets: [], intentFallbacks: {} } };
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('publish worker', () => {
  it('builds, renews immediately before atomic activation, health checks, and completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-worker-')); roots.push(root); vi.stubEnv('SITE_THEME_VERSION', pins.themeVersion); vi.stubEnv('SITE_ENGINE_VERSION', pins.engineVersion);
    const snapshot = structuredClone(neutralFixture); const registry = parseThemeRegistry({ themes: [{ manifest: themeManifest, installedAt: '2026-10-03T00:00:00.000Z' }] }); const selection = { id: themeManifest.name, version: themeManifest.version, contract: themeManifest.contract, manifestDigest: getInstalledTheme(registry, themeManifest.name, themeManifest.version)!.manifestDigest }; snapshot.settings.theme = selection; const contentHash = (await import('./../scripts/run-preview-worker.mjs')).hash(snapshot); const calls: string[] = []; const renders: Array<Record<string, unknown>> = [];
    const api = async (action: string, body: Record<string, unknown> = {}) => { calls.push(action); if (action === 'claim') return { job, snapshot, contentHash, versionPins: pins }; if (action === 'renew') return { job }; if (action === 'complete') return { job: { status: 'completed' } }; return { job: {} }; };
    const releasesRoot = join(root, 'releases'); const server = createPublicServer({ releasesRoot }); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server did not listen.');
    const render = async (rendererOptions: Parameters<typeof import('../scripts/build-snapshot.mjs').buildSnapshot>[0] & Record<string, unknown>) => { renders.push(rendererOptions); return (await import('../scripts/build-snapshot.mjs')).buildSnapshot(rendererOptions); };
    try { await expect(runPublishOnce({ api, buildRoot: root, releasesRoot, publicOrigin: `http://127.0.0.1:${address.port}`, versionPins: pins, registry, render })).resolves.toBe(true); }
    finally { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
    expect(calls).toEqual(['claim', 'renew', 'complete']); expect(renders[0]).toMatchObject({ themeSelection: selection, versionPins: pins }); expect(await readFile(join(root, 'releases/current/healthz'), 'utf8')).toContain('ok');
  }, 60_000);
  it('serves approved archive and slug-change redirects from the worker-built immutable artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-worker-')); roots.push(root);
    vi.stubEnv('SITE_THEME_VERSION', pins.themeVersion); vi.stubEnv('SITE_ENGINE_VERSION', pins.engineVersion);
    const snapshot = structuredClone(neutralFixture);
    const section = snapshot.settings.sections[0]!;
    section.allowedTemplates = [...section.allowedTemplates, 'standard'];
    const retired = { ...structuredClone(snapshot.pages[0]!), id: 'f0000000-0000-4000-8000-000000000001', sectionId: section.id, title: 'Retired public page', summary: 'A published page removed by an approved archive change.', slug: 'retired-public-page', template: 'standard' as const, status: 'archived' as const, blocks: [] };
    snapshot.pages.push(retired); section.pageIds.push(retired.id);
    const oldPath = `/${section.slug}/${retired.slug}`;
    const renamed = { ...structuredClone(snapshot.pages[0]!), id: 'f0000000-0000-4000-8000-000000000002', sectionId: section.id, title: 'Renamed public page', summary: 'A published page after an approved slug change.', slug: 'renamed-public-page', template: 'standard' as const, status: 'published' as const, blocks: [] };
    snapshot.pages.push(renamed); section.pageIds.push(renamed.id);
    const priorSlugPath = `/${section.slug}/previous-public-page`;
    const canonicalPath = `/${section.slug}/${renamed.slug}`;
    // This is the frozen approved manifest: the archived record is absent from
    // rendered routes and its approval-created redirect remains in the release.
    snapshot.redirects = [{ from: oldPath, to: '/', status: 301 }, { from: priorSlugPath, to: canonicalPath, status: 301 }];
    const contentHash = (await import('./../scripts/run-preview-worker.mjs')).hash(snapshot);
    const calls: string[] = [];
    const api = async (action: string) => { calls.push(action); return action === 'claim' ? { job, snapshot, contentHash, versionPins: pins } : action === 'renew' ? { job } : { job: { status: 'completed' } }; };
    const releasesRoot = join(root, 'releases');
    const server = createPublicServer({ releasesRoot });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server did not listen.');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      await expect(runPublishOnce({ api, buildRoot: root, releasesRoot, publicOrigin: origin, versionPins: pins })).resolves.toBe(true);
      const response = await fetch(`${origin}${oldPath}`, { redirect: 'manual' });
      expect(response.status).toBe(301);
      expect(response.headers.get('location')).toBe('/');
      const slugChange = await fetch(`${origin}${priorSlugPath}`, { redirect: 'manual' });
      expect(slugChange.status).toBe(301); expect(slugChange.headers.get('location')).toBe(canonicalPath);
      expect((await fetch(`${origin}${canonicalPath}`)).status).toBe(200);
      const redirects = await readFile(join(releasesRoot, 'current', 'redirects.json'), 'utf8');
      expect(redirects).toContain(oldPath); expect(redirects).toContain(priorSlugPath);
    } finally { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
    expect(calls).toEqual(['claim', 'renew', 'complete']);
  }, 60_000);
  it('uses the frozen approval manifest when a newer draft exists by the time the worker publishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-worker-')); roots.push(root);
    vi.stubEnv('SITE_THEME_VERSION', pins.themeVersion); vi.stubEnv('SITE_ENGINE_VERSION', pins.engineVersion);
    const approved = structuredClone(neutralFixture); approved.pages[0]!.title = 'Approved immutable title';
    const mutableDraft = structuredClone(approved); mutableDraft.pages[0]!.title = 'Edited after approval';
    const contentHash = (await import('./../scripts/run-preview-worker.mjs')).hash(approved);
    const token = 'p'.repeat(40); const calls: string[] = []; let completedArtifact: Record<string, unknown> | undefined;
    const cms = createServer(async (request, response) => {
      const action = new URL(request.url ?? '/', 'http://localhost').pathname.split('/').pop(); calls.push(String(action));
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
      if (action === 'claim') { mutableDraft.pages[0]!.title = 'Edited after approval'; response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ job, snapshot: approved, contentHash, versionPins: pins })); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (action === 'renew') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ job: { ...job, leaseToken: body.leaseToken } })); return; }
      if (action === 'complete') { completedArtifact = body.artifact; response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ job: { status: 'completed' } })); return; }
      response.writeHead(400).end();
    });
    await new Promise<void>(done => cms.listen(0, '127.0.0.1', done)); const cmsAddress = cms.address(); if (!cmsAddress || typeof cmsAddress === 'string') throw new Error('CMS fixture did not listen.');
    const releasesRoot = join(root, 'releases'); const publicServer = createPublicServer({ releasesRoot }); await new Promise<void>(done => publicServer.listen(0, '127.0.0.1', done)); const publicAddress = publicServer.address(); if (!publicAddress || typeof publicAddress === 'string') throw new Error('Public fixture did not listen.');
    try {
      await expect(runPublishOnce({ api: createPublishAPI({ cmsOrigin: `http://127.0.0.1:${cmsAddress.port}`, token }), buildRoot: root, releasesRoot, publicOrigin: `http://127.0.0.1:${publicAddress.port}`, versionPins: pins })).resolves.toBe(true);
      const html = await readFile(join(releasesRoot, 'current', 'index.html'), 'utf8');
      expect(html).toContain('Approved immutable title'); expect(html).not.toContain(mutableDraft.pages[0]!.title);
      expect(completedArtifact).toMatchObject({ sourceContentHash: contentHash }); expect(calls).toEqual(['claim', 'renew', 'complete']);
    } finally { await Promise.all([new Promise<void>((done, reject) => cms.close(error => error ? reject(error) : done())), new Promise<void>((done, reject) => publicServer.close(error => error ? reject(error) : done()))]); }
  }, 60_000);
  it('recovers a dropped completion response without a second activation or duplicate terminal release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-worker-')); roots.push(root);
    vi.stubEnv('SITE_THEME_VERSION', pins.themeVersion); vi.stubEnv('SITE_ENGINE_VERSION', pins.engineVersion);
    const snapshot = structuredClone(neutralFixture); const contentHash = (await import('./../scripts/run-preview-worker.mjs')).hash(snapshot); const token = 'r'.repeat(40);
    let claims = 0; let terminalReleases = 0; const completionTokens: string[] = [];
    const cms = createServer(async (request, response) => {
      const action = new URL(request.url ?? '/', 'http://localhost').pathname.split('/').pop();
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
      if (action === 'claim') { const leaseToken = claims++ ? 'c'.repeat(36) : job.leaseToken; response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ job: { ...job, leaseToken }, snapshot, contentHash, versionPins: pins })); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (action === 'renew') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ job: { ...job, leaseToken: body.leaseToken } })); return; }
      if (action === 'complete') { completionTokens.push(body.leaseToken); if (terminalReleases === 0) { terminalReleases += 1; response.destroy(); return; } response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ job: { status: 'completed' } })); return; }
      // The first worker's best-effort fail request must not erase the durable completion.
      if (action === 'fail') { response.writeHead(409).end(); return; }
      response.writeHead(400).end();
    });
    await new Promise<void>(done => cms.listen(0, '127.0.0.1', done)); const cmsAddress = cms.address(); if (!cmsAddress || typeof cmsAddress === 'string') throw new Error('CMS fixture did not listen.');
    const releasesRoot = join(root, 'releases'); const publicServer = createPublicServer({ releasesRoot }); await new Promise<void>(done => publicServer.listen(0, '127.0.0.1', done)); const publicAddress = publicServer.address(); if (!publicAddress || typeof publicAddress === 'string') throw new Error('Public fixture did not listen.');
    const worker = () => runPublishOnce({ api: createPublishAPI({ cmsOrigin: `http://127.0.0.1:${cmsAddress.port}`, token }), buildRoot: root, releasesRoot, publicOrigin: `http://127.0.0.1:${publicAddress.port}`, versionPins: pins });
    try {
      await expect(worker()).rejects.toThrow('BUILD_FAILED');
      await expect(worker()).resolves.toBe(true);
      expect(terminalReleases).toBe(1); // second completion is an idempotent acknowledgement, not a new release.
      expect(completionTokens).toEqual([job.leaseToken, 'c'.repeat(36)]);
      expect((await readdir(releasesRoot)).filter(name => name.startsWith('release-'))).toEqual([`release-1-${job.id}`]);
    } finally { await Promise.all([new Promise<void>((done, reject) => cms.close(error => error ? reject(error) : done())), new Promise<void>((done, reject) => publicServer.close(error => error ? reject(error) : done()))]); }
  }, 60_000);
  it('publishes a selected upgrade with its job pin while the worker has an older configured theme', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-worker-')); roots.push(root); vi.stubEnv('SITE_THEME_VERSION', '1.0.0'); vi.stubEnv('SITE_ENGINE_VERSION', pins.engineVersion);
    const older = { ...themeManifest, version: '1.0.0' }; const newer = { ...themeManifest, version: '1.0.1' };
    const registry = parseThemeRegistry({ themes: [{ manifest: older, installedAt: '2026-10-03T00:00:00.000Z' }, { manifest: newer, installedAt: '2026-10-04T00:00:00.000Z' }] });
    const snapshot = structuredClone(neutralFixture); snapshot.settings.theme = { id: newer.name, version: newer.version, contract: newer.contract, manifestDigest: getInstalledTheme(registry, newer.name, newer.version)!.manifestDigest };
    const upgradedPins = { ...pins, themeVersion: newer.version }; const contentHash = (await import('./../scripts/run-preview-worker.mjs')).hash(snapshot); const renders: Array<Record<string, unknown>> = [];
    const api = async (action: string) => action === 'claim' ? { job, snapshot, contentHash, versionPins: upgradedPins } : action === 'renew' ? { job } : { job: {} };
    const render = async (options: Parameters<typeof import('../scripts/build-snapshot.mjs').buildSnapshot>[0] & Record<string, unknown>) => { renders.push(options); return (await import('../scripts/build-snapshot.mjs')).buildSnapshot(options); };
    await expect(runPublishOnce({ api, buildRoot: root, releasesRoot: join(root, 'releases'), publicOrigin: 'https://example.test', versionPins: pins, registry, render, healthProbe: async () => true })).resolves.toBe(true);
    expect(renders[0]?.versionPins).toEqual(upgradedPins);
    expect(JSON.parse(await readFile(join(root, 'releases', 'current', 'snapshot-manifest.json'), 'utf8')).sourceVersions.themeVersion).toBe('1.0.1');
  }, 60_000);
  it('publishes supported 1.1 and retained 1.0 claims in one worker configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-worker-')); roots.push(root)
    const older = { ...themeManifest, version: '1.0.0', contract: '1.0.0' }; const newer = { ...themeManifest, version: '1.1.0', contract: '1.1.0' }
    const registry = parseThemeRegistry({ themes: [{ manifest: older, installedAt: '2026-10-03T00:00:00.000Z' }, { manifest: newer, installedAt: '2026-10-04T00:00:00.000Z' }] })
    const selection = (manifest: typeof themeManifest) => ({ id: manifest.name, version: manifest.version, contract: manifest.contract, manifestDigest: getInstalledTheme(registry, manifest.name, manifest.version)!.manifestDigest })
    const upgraded = structuredClone(neutralFixture); upgraded.settings.contractVersion = '1.1.0'; upgraded.settings.theme = selection(newer)
    const legacy = structuredClone(neutralFixture); legacy.settings.theme = selection(older)
    const claims = [{ job: { ...job, sequence: 1 }, snapshot: upgraded, contentHash: (await import('./../scripts/run-preview-worker.mjs')).hash(upgraded), versionPins: { ...pins, themeVersion: newer.version, contractVersion: '1.1.0' } }, { job: { ...job, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sequence: 2 }, snapshot: legacy, contentHash: (await import('./../scripts/run-preview-worker.mjs')).hash(legacy), versionPins: { ...pins, themeVersion: older.version, contractVersion: '1.0.0' } }]
    const rendered: Array<Record<string, unknown>> = []; let claimIndex = 0
    const api = async (action: string) => action === 'claim' ? claims[claimIndex++] : action === 'renew' ? { job: claims[claimIndex - 1]!.job } : { job: {} }
    const render = async (options: Parameters<typeof import('../scripts/build-snapshot.mjs').buildSnapshot>[0] & Record<string, unknown>) => { rendered.push(options); return (await import('../scripts/build-snapshot.mjs')).buildSnapshot(options) }
    const worker = { api, buildRoot: root, releasesRoot: join(root, 'releases'), publicOrigin: 'https://example.test', versionPins: pins, registry, render, healthProbe: async () => true }
    await expect(runPublishOnce(worker)).resolves.toBe(true); await expect(runPublishOnce(worker)).resolves.toBe(true)
    expect(rendered.map(item => item.versionPins)).toEqual([claims[0]!.versionPins, claims[1]!.versionPins])
    expect(JSON.parse(await readFile(join(root, 'releases', 'current', 'snapshot-manifest.json'), 'utf8')).sourceVersions).toMatchObject({ contractVersion: '1.0.0', themeVersion: '1.0.0' })
  }, 60_000)

  it('rejects unsupported and snapshot-mismatched contract claims before rendering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-worker-')); roots.push(root); const snapshot = structuredClone(neutralFixture); const contentHash = (await import('./../scripts/run-preview-worker.mjs')).hash(snapshot); const render = vi.fn(async () => { throw new Error('render must not run') })
    const worker = (versionPins: Record<string, string>, candidate = snapshot) => runPublishOnce({ api: async (action: string) => action === 'claim' ? { job, snapshot: candidate, contentHash, versionPins } : { job: {} }, buildRoot: root, releasesRoot: join(root, 'releases'), publicOrigin: 'https://example.test', versionPins: pins, render, healthProbe: async () => true })
    await expect(worker({ ...pins, contractVersion: '9.0.0' })).rejects.toThrow('INVALID_CLAIM')
    await expect(worker({ ...pins, contractVersion: '1.1.0' })).rejects.toThrow('INVALID_CLAIM')
    expect(render).not.toHaveBeenCalled()
  })

  it('fails closed when a custom renderer returns an artifact with a bad manifest proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-worker-')); roots.push(root); vi.stubEnv('SITE_THEME_VERSION', pins.themeVersion); vi.stubEnv('SITE_ENGINE_VERSION', pins.engineVersion);
    const snapshot = structuredClone(neutralFixture); const contentHash = (await import('./../scripts/run-preview-worker.mjs')).hash(snapshot); const calls: string[] = [];
    const api = async (action: string) => { calls.push(action); return action === 'claim' ? { job, snapshot, contentHash, versionPins: pins } : action === 'renew' ? { job } : { job: {} }; };
    const render = async (rendererOptions: Parameters<typeof import('../scripts/build-snapshot.mjs').buildSnapshot>[0]) => {
      const built = await (await import('../scripts/build-snapshot.mjs')).buildSnapshot(rendererOptions);
      await (await import('node:fs/promises')).writeFile(join(built.output, 'snapshot-manifest.json'), '{"invalid":true}');
      return built;
    };
    await expect(runPublishOnce({ api, buildRoot: root, releasesRoot: join(root, 'releases'), publicOrigin: 'https://example.test', versionPins: pins, render, healthProbe: async () => true })).rejects.toThrow('BUILD_FAILED');
    expect(calls).toContain('fail'); await expect(readFile(join(root, 'releases/current/healthz'))).rejects.toThrow();
  }, 60_000);
  it('rejects a published snapshot whose frozen theme digest is not installed before rendering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-worker-')); roots.push(root);
    const snapshot = structuredClone(neutralFixture); const registry = parseThemeRegistry({ themes: [{ manifest: themeManifest, installedAt: '2026-10-03T00:00:00.000Z' }] });
    snapshot.settings.theme = { id: themeManifest.name, version: themeManifest.version, contract: themeManifest.contract, manifestDigest: '0'.repeat(64) };
    const contentHash = (await import('./../scripts/run-preview-worker.mjs')).hash(snapshot);
    const render = vi.fn(async () => { throw new Error('renderer must not run'); });
    await expect(runPublishOnce({ api: async (action: string) => action === 'claim' ? { job, snapshot, contentHash, versionPins: pins } : { job: {} }, buildRoot: root, releasesRoot: join(root, 'releases'), publicOrigin: 'https://example.test', versionPins: pins, registry, render, healthProbe: async () => true })).rejects.toThrow(/exactly as reviewed/);
    expect(render).not.toHaveBeenCalled();
  });

  it('does not activate when the final lease renewal is lost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-worker-')); roots.push(root); vi.stubEnv('SITE_THEME_VERSION', pins.themeVersion); vi.stubEnv('SITE_ENGINE_VERSION', pins.engineVersion); const snapshot = structuredClone(neutralFixture); const contentHash = (await import('./../scripts/run-preview-worker.mjs')).hash(snapshot);
    const api = async (action: string) => action === 'claim' ? { job, snapshot, contentHash, versionPins: pins } : action === 'renew' ? { job: { ...job, leaseToken: 'different' } } : { job: {} };
    await expect(runPublishOnce({ api, buildRoot: root, releasesRoot: join(root, 'releases'), publicOrigin: 'https://example.test', versionPins: pins, healthProbe: async () => true })).rejects.toThrow('LEASE_LOST');
    await expect(readFile(join(root, 'releases/current/healthz'))).rejects.toThrow();
  }, 60_000);
  it('rejects an HTTP 200 health response that proves the old artifact and rolls back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-worker-')); roots.push(root); const snapshot = structuredClone(neutralFixture); const contentHash = (await import('./../scripts/run-preview-worker.mjs')).hash(snapshot);
    const api = async (action: string) => action === 'claim' ? { job, snapshot, contentHash, versionPins: pins } : action === 'renew' ? { job } : { job: {} };
    const server = createServer((_request, response) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jobID: 'old-job', sequence: 0, contentHash, versionPins: pins })));
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server did not listen.');
    try { await expect(runPublishOnce({ api, buildRoot: root, releasesRoot: join(root, 'releases'), publicOrigin: `http://127.0.0.1:${address.port}`, versionPins: pins })).rejects.toThrow('BUILD_FAILED'); }
    finally { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
    await expect(readFile(join(root, 'releases/current/healthz'))).rejects.toThrow();
  }, 60_000);
  it('reuses the activated artifact after a completion response loss and completes a reclaimed lease without rebuilding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'publish-worker-')); roots.push(root); vi.stubEnv('SITE_THEME_VERSION', pins.themeVersion); vi.stubEnv('SITE_ENGINE_VERSION', pins.engineVersion);
    const snapshot = structuredClone(neutralFixture); const contentHash = (await import('./../scripts/run-preview-worker.mjs')).hash(snapshot); let pass = 0; const completed: string[] = [];
    const api = async (action: string, body: Record<string, unknown> = {}) => {
      if (action === 'claim') return { job: { ...job, leaseToken: pass++ ? 'c'.repeat(36) : job.leaseToken }, snapshot, contentHash, versionPins: pins };
      if (action === 'renew') return { job: { ...job, leaseToken: body.leaseToken, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } };
      if (action === 'complete') { completed.push(String(body.leaseToken)); if (completed.length === 1) throw new Error('response dropped after persistence'); return { job: { status: 'completed' } }; }
      return { job: {} };
    };
    await expect(runPublishOnce({ api, buildRoot: root, releasesRoot: join(root, 'releases'), publicOrigin: 'https://example.test', versionPins: pins, healthProbe: async () => true })).rejects.toThrow('BUILD_FAILED');
    const neverRender = vi.fn(async () => { throw new Error('reclaimed release must not rebuild'); });
    await expect(runPublishOnce({ api, buildRoot: root, releasesRoot: join(root, 'releases'), publicOrigin: 'https://example.test', versionPins: pins, render: neverRender, healthProbe: async () => true })).resolves.toBe(true);
    expect(neverRender).not.toHaveBeenCalled(); expect(completed).toHaveLength(2); expect(await readFile(join(root, 'releases/current/healthz'), 'utf8')).toContain('ok');
  }, 60_000);
});
