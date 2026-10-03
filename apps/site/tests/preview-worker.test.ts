import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { neutralFixture } from '@site-engine/contract/fixtures';
import { canonical, createPreviewAPI, hash, runPreviewOnce } from '../scripts/run-preview-worker.mjs';
import { buildSnapshot } from '../scripts/build-snapshot.mjs';
import { parseThemeRegistry } from '../scripts/theme-registry.mjs';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const pins = { engineVersion: '1.0.0', themeVersion: '1.0.0', contractVersion: '1.0.0' };
const secret = 'synthetic-preview-worker-token-32-characters';
const themeManifest = { name: 'synthetic-theme', version: '1.0.0', contract: '1.0.0', entry: './dist/renderer.js', standardBlocks: ['hero', 'faq'], settingKeys: ['tone'], extensionBlocks: [], motion: { presets: [], intentFallbacks: {} } };
let root: string;
let servers: Server[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'preview-worker-test-'));
  servers = [];
  vi.stubEnv('SITE_ENGINE_VERSION', pins.engineVersion);
  vi.stubEnv('SITE_THEME_VERSION', pins.themeVersion);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  await rm(root, { recursive: true, force: true });
});

function claim() {
  const live = structuredClone(neutralFixture);
  const proposed = structuredClone(neutralFixture);
  proposed.pages[0]!.title = 'Proposed worker page';
  const hero = proposed.pages[0]!.blocks[0]!;
  if (hero.type === 'hero') hero.heading = 'Proposed worker heading';
  return { job: { id, leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }, live, proposed, basePaths: { live: 'live', proposed: 'proposed' }, versionPins: pins };
}

function themedClaim() {
  const input = claim(); const selection = { id: themeManifest.name, version: themeManifest.version, contract: themeManifest.contract, manifestDigest: parseThemeRegistry({ themes: [{ manifest: themeManifest, installedAt: '2026-10-03T00:00:00.000Z' }] }).get(themeManifest.name).manifestDigest };
  input.live.settings.theme = selection;
  input.proposed.settings.theme = selection;
  return { input, selection, registry: parseThemeRegistry({ themes: [{ manifest: themeManifest, installedAt: '2026-10-03T00:00:00.000Z' }] }) };
}

const options = () => ({ artifactRoot: root, publicOrigin: 'https://example.test', versionPins: pins, signal: undefined });

describe('durable preview rendering worker', () => {
  it('renders exact live/proposed snapshots, retains only served artifacts, and reuses verified output after a lost callback', async () => {
    const input = claim();
    const calls: { action: string; body: Record<string, unknown> }[] = [];
    let loseResponse = true;
    const api = async (action: string, body: Record<string, unknown> = {}) => {
      calls.push({ action, body });
      if (action === 'claim') return input;
      if (action === 'complete' && loseResponse) { loseResponse = false; throw new Error('synthetic transport failure'); }
      return { ok: true };
    };
    await expect(runPreviewOnce({ ...options(), api })).rejects.toThrow('BUILD_FAILED');
    const files = await readdir(root);
    expect(files).toEqual([id]);
    expect(await readdir(join(root, id))).toEqual(['live', 'proposed']);
    const html = await readFile(join(root, id, 'proposed', 'index.html'), 'utf8');
    expect(html).toContain('Proposed worker heading');
    expect(html).toContain(`/preview/changes/${id}/proposed/`);
    expect(JSON.parse(await readFile(join(root, id, 'proposed', 'search-index.json'), 'utf8'))).toEqual({ version: 1, documents: [] });
    expect(await readFile(join(root, id, 'live', 'index.html'), 'utf8')).not.toContain('Proposed worker heading');
    const neverRender = vi.fn(async () => { throw new Error('A verified retry must not rebuild.'); });
    expect(await runPreviewOnce({ ...options(), api, render: neverRender })).toBe(true);
    expect(neverRender).not.toHaveBeenCalled();
    const proof = calls.filter(call => call.action === 'complete').at(-1)!.body;
    expect(proof).toMatchObject({ id, liveManifestHash: hash(input.live), proposedManifestHash: hash(input.proposed) });
    expect(proof.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(join(root, id, 'proposed', 'index.html'), 'tampered output');
    await expect(runPreviewOnce({ ...options(), api, render: neverRender })).rejects.toThrow('INVALID_ARTIFACT');
    expect(calls.filter(call => call.action === 'complete')).toHaveLength(2);
  }, 60_000);

  it('passes the exact frozen input, preview base path, pins, and origin to a configured renderer', async () => {
    const { input, selection, registry } = themedClaim(); const seen: Array<Record<string, unknown>> = [];
    const render = async (rendererOptions: Record<string, unknown>) => { seen.push({ ...rendererOptions, frozen: await readFile(String(rendererOptions.input), 'utf8') }); return buildSnapshot(rendererOptions as Parameters<typeof buildSnapshot>[0]); };
    const api = async (action: string) => action === 'claim' ? input : { ok: true };
    await expect(runPreviewOnce({ ...options(), api, registry, render })).resolves.toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ publicOrigin: 'https://example.test', basePath: `/preview/changes/${id}/live/`, versionPins: pins });
    expect(seen[1]).toMatchObject({ publicOrigin: 'https://example.test', basePath: `/preview/changes/${id}/proposed/`, versionPins: pins });
    expect(seen.map(item => item.themeSelection)).toEqual([selection, selection]);
    expect(seen[0]!.frozen).toBe(canonical(input.live));
    expect(seen[1]!.frozen).toBe(canonical(input.proposed));
  }, 60_000);

  it('rejects a frozen theme selection whose digest does not match the installed registry before rendering', async () => {
    const { input, registry } = themedClaim();
    input.proposed.settings.theme!.manifestDigest = '0'.repeat(64);
    const render = vi.fn(async () => { throw new Error('renderer must not run'); });
    await expect(runPreviewOnce({ ...options(), api: async (action: string) => action === 'claim' ? input : { ok: true }, registry, render })).rejects.toThrow(/exactly as reviewed/);
    expect(render).not.toHaveBeenCalled();
  });

  it('cancels a running render on lease loss, cleans scratch files, and never completes or fails an old lease', async () => {
    const calls: string[] = [];
    const api = async (action: string) => {
      calls.push(action);
      if (action === 'claim') return claim();
      if (action === 'renew') throw new Error('lease already reclaimed');
      return { ok: true };
    };
    const render = async ({ signal }: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      if (signal!.aborted) return reject(new Error('cancelled'));
      signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
    await expect(runPreviewOnce({ ...options(), api, render, heartbeatMs: 5 })).rejects.toThrow('LEASE_LOST');
    expect(calls).toEqual(['claim', 'renew']);
    expect(await readdir(root)).toEqual([]);
  });

  it('terminates a real Astro child on cancellation and removes private staging input', async () => {
    const input = join(root, 'source.json');
    await writeFile(input, canonical(neutralFixture));
    const controller = new AbortController();
    const pending = buildSnapshot({ input, outputRoot: root, publicOrigin: 'https://example.test', signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 25);
    try { await expect(pending).rejects.toThrow('cancelled'); }
    finally { clearTimeout(timer); }
    expect(await readdir(root)).toEqual(['source.json']);
  });

  it('reports only bounded error codes and rejects path/version manipulation before rendering', async () => {
    const requests: unknown[] = [];
    const api = async (action: string, body?: unknown) => {
      requests.push(body);
      return action === 'claim' ? claim() : { ok: true };
    };
    const render = async () => { throw new Error('secret synthetic value must not leave renderer'); };
    await expect(runPreviewOnce({ ...options(), api, render })).rejects.toThrow('BUILD_FAILED');
    expect(JSON.stringify(requests)).not.toContain('secret synthetic');
    expect(requests).toContainEqual(expect.objectContaining({ errorCode: 'BUILD_FAILED' }));
    expect(await readdir(root)).toEqual([]);
    const bad = claim(); bad.job.id = '../escape';
    await expect(runPreviewOnce({ ...options(), api: async () => bad, render })).rejects.toThrow('INVALID_CLAIM');
    const wrongVersion = claim(); wrongVersion.versionPins = { ...pins, engineVersion: '9.0.0' };
    await expect(runPreviewOnce({ ...options(), api: async () => wrongVersion, render })).rejects.toThrow('INVALID_CLAIM');
    expect(await runPreviewOnce({ ...options(), api: async () => ({ job: null }), render })).toBe(false);
  });
});

describe('private worker API boundary', () => {
  it('never follows redirects with the worker credential', async () => {
    let destinationHits = 0;
    const server = createServer((request, response) => {
      if (request.url === '/credential-sink') { destinationHits++; response.end('unexpected'); }
      else { response.writeHead(302, { location: '/credential-sink' }); response.end(); }
    });
    servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server address.');
    const api = createPreviewAPI({ cmsOrigin: `http://127.0.0.1:${address.port}`, token: secret });
    await expect(api('claim')).rejects.toThrow();
    expect(destinationHits).toBe(0);
    expect(() => createPreviewAPI({ cmsOrigin: 'http://user:password@example.test', token: secret })).toThrow();
    expect(() => createPreviewAPI({ cmsOrigin: 'https://example.test/path', token: secret })).toThrow();
    expect(() => createPreviewAPI({ cmsOrigin: 'https://example.test', token: 'short' })).toThrow();
  });

  it('cancels oversized streamed responses and rejects malformed content', async () => {
    let cancelled = false;
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
    const oversized = createPreviewAPI({ cmsOrigin: 'http://cms.test', token: secret, fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }) });
    await expect(oversized('claim')).rejects.toThrow('INVALID_CMS_RESPONSE');
    expect(cancelled).toBe(true);
    const malformed = createPreviewAPI({ cmsOrigin: 'http://cms.test', token: secret, fetchImpl: async () => new Response('invalid', { headers: { 'content-type': 'application/json' } }) });
    await expect(malformed('claim')).rejects.toThrow('INVALID_CMS_RESPONSE');
    expect(canonical({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });
});
