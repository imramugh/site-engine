import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { neutralFixture } from '@site-engine/contract/fixtures';
import { runPublishOnce } from '../scripts/run-publish-worker.mjs';
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
