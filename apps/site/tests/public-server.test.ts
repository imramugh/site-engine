import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createPublicServer } from '../scripts/public-server.mjs';
import { activatePublicRelease } from '../scripts/public-release.mjs';

const roots: string[] = []; const pins = { contentHash: 'h', themeVersion: '1.0.0', engineVersion: '1.0.0', contractVersion: '1.0.0' }; const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function artifact(root: string, name: string, extra: Record<string, string> = {}) { const directory = join(root, name); await mkdir(directory); const files = { 'index.html': 'live', 'healthz': 'ignored', 'app.12345678.js': 'abcdefgh', 'redirects.json': '[{"from":"/old","to":"/new","status":301}]', ...extra }; for (const [file, body] of Object.entries(files)) { const target = join(directory, file); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, body); } await writeFile(join(directory, 'snapshot-manifest.json'), JSON.stringify({ snapshotContentHash: 'h', sourceVersions: { themeVersion: '1.0.0', engineVersion: '1.0.0', contractVersion: '1.0.0' }, files: Object.fromEntries(Object.entries(files).map(([file, body]) => [file, hash(body)])) })); return directory; }
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

it('serves only current files, Astro directory routes, and valid single ranges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-')); roots.push(root); const initial = await artifact(root, 'initial', { 'initial-only.html': 'bootstrap' }); const current = await artifact(root, 'current', { 'section/page/index.html': 'nested' }); const releases = join(root, 'releases'); const server = createPublicServer({ releasesRoot: releases, initialArtifactDir: initial }); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address() as { port: number }; const origin = `http://127.0.0.1:${address.port}`;
  try {
    expect(await (await fetch(`${origin}/initial-only.html`)).text()).toBe('bootstrap'); expect(await (await fetch(`${origin}/healthz`)).json()).toEqual({ status: 'bootstrap' });
    await activatePublicRelease({ releasesRoot: releases, artifact: current, jobID: 'job', sequence: 1, pins, health: async () => true });
    expect((await fetch(`${origin}/initial-only.html`)).status).toBe(404); expect(await (await fetch(`${origin}/section/page/`)).text()).toBe('nested'); expect(await (await fetch(`${origin}/section/page`)).text()).toBe('nested'); expect((await fetch(`${origin}/old`, { redirect: 'manual' })).status).toBe(301);
    const suffix = await fetch(`${origin}/app.12345678.js`, { headers: { range: 'bytes=-3' } }); expect([suffix.status, await suffix.text(), suffix.headers.get('content-range')]).toEqual([206, 'fgh', 'bytes 5-7/8']); expect((await fetch(`${origin}/app.12345678.js`, { method: 'POST' })).status).toBe(405); expect((await fetch(`${origin}/app.12345678.js`, { headers: { range: 'bytes=0-1,3-4' } })).status).toBe(416);
    expect(await (await fetch(`${origin}/healthz`)).json()).toEqual({ jobID: 'job', sequence: 1, contentHash: 'h', versionPins: { themeVersion: '1.0.0', engineVersion: '1.0.0', contractVersion: '1.0.0' } }); await writeFile(join(releases, '.activation.json'), '{'); expect((await fetch(`${origin}/healthz`)).status).toBe(503);
  } finally { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
});
