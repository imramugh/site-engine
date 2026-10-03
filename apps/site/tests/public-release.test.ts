import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activatePublicRelease, publicArtifactFile, publicReleaseProof, verifyPublicArtifact } from '../scripts/public-release.mjs';

const roots: string[] = [];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const pins = { contentHash: 'hash', themeVersion: '1.0.0', engineVersion: '1.0.0', contractVersion: '1.0.0' };

async function artifact(root: string, text = 'ok') {
  const dir = join(root, `artifact-${text}`);
  await mkdir(dir);
  await writeFile(join(dir, 'index.html'), text);
  await writeFile(join(dir, 'snapshot-manifest.json'), JSON.stringify({
    snapshotContentHash: 'hash',
    sourceVersions: { themeVersion: '1.0.0', engineVersion: '1.0.0', contractVersion: '1.0.0' },
    files: { 'index.html': sha(text) },
  }));
  return dir;
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('public immutable release adapter', () => {
  it('activates, resumes after an activation-before-ack crash, rejects conflicts, and rolls back failed health', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-')); roots.push(root);
    const releasesRoot = join(root, 'releases'); const first = await artifact(root, 'first');
    await expect(activatePublicRelease({ releasesRoot, artifact: first, jobID: 'job-one', sequence: 1, pins })).resolves.toMatchObject({ activated: true });
    expect(await readFile(join(releasesRoot, 'current/index.html'), 'utf8')).toBe('first');

    // Models a crash after pointer activation and journal write but before the CMS complete acknowledgement.
    await expect(activatePublicRelease({ releasesRoot, artifact: first, jobID: 'job-one', sequence: 1, pins })).resolves.toMatchObject({ resumed: true });
    await writeFile(join(releasesRoot, '.activation.json'), JSON.stringify({ jobID: 'job-one', sequence: 1, artifact: join(releasesRoot, 'release-1-job-one'), release: 'release-1-job-one', state: 'activating' }));
    const recoveredHealth = vi.fn(async () => true);
    await expect(activatePublicRelease({ releasesRoot, artifact: first, jobID: 'job-one', sequence: 1, pins, health: recoveredHealth })).resolves.toMatchObject({ resumed: true });
    expect(recoveredHealth).toHaveBeenCalledOnce();
    await expect(activatePublicRelease({ releasesRoot, artifact: first, jobID: 'job-one', sequence: 2, pins })).rejects.toThrow('Conflicting sequence');
    await expect(activatePublicRelease({ releasesRoot, artifact: first, jobID: 'older', sequence: 0, pins })).rejects.toThrow('Older');

    const second = await artifact(root, 'second');
    await expect(activatePublicRelease({ releasesRoot, artifact: second, jobID: 'job-two', sequence: 2, pins, health: async () => false })).rejects.toThrow('health');
    expect(await readFile(join(releasesRoot, 'current/index.html'), 'utf8')).toBe('first');
    await expect(activatePublicRelease({ releasesRoot, artifact: second, jobID: 'job-two', sequence: 2, pins })).resolves.toMatchObject({ activated: true });
    expect(await readFile(join(releasesRoot, 'current/index.html'), 'utf8')).toBe('second');
  });

  it('serves only the current artifact through an HTTP handler and hides manifest control files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-')); roots.push(root);
    const releasesRoot = join(root, 'releases'); const first = await artifact(root, 'served');
    await activatePublicRelease({ releasesRoot, artifact: first, jobID: 'job-http', sequence: 1, pins });
    const server = createServer(async (request, response) => {
      try {
        const file = await publicArtifactFile(releasesRoot, new URL(request.url ?? '/', 'http://localhost').pathname);
        response.writeHead(200).end(await readFile(file));
      } catch { response.writeHead(404).end(); }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server did not listen.');
    try {
      await expect(fetch(`http://127.0.0.1:${address.port}/`).then((response) => response.text())).resolves.toBe('served');
      await expect(fetch(`http://127.0.0.1:${address.port}/snapshot-manifest.json`).then((response) => response.status)).resolves.toBe(404);
      await expect(fetch(`http://127.0.0.1:${address.port}/.activation.json`).then((response) => response.status)).resolves.toBe(404);
    } finally { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); }
  });

  it('rejects checksum corruption and symlinked artifact paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-')); roots.push(root);
    const target = await artifact(root); await writeFile(join(target, 'index.html'), 'corrupt');
    await expect(verifyPublicArtifact(target)).rejects.toThrow('checksum');
    const linked = await artifact(root, 'linked'); await symlink('/tmp', join(linked, 'escape'));
    await expect(verifyPublicArtifact(linked)).rejects.toThrow('symbolic');
  });

  it('checks the lease after staging and before switching current', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-')); roots.push(root);
    const releasesRoot = join(root, 'releases'); const candidate = await artifact(root, 'candidate');
    const assertLease = vi.fn(async () => {
      await expect(readFile(join(releasesRoot, 'release-1-job-lease/index.html'), 'utf8')).resolves.toBe('candidate');
      return false;
    });
    await expect(activatePublicRelease({ releasesRoot, artifact: candidate, jobID: 'job-lease', sequence: 1, pins, assertLease })).rejects.toThrow('lease');
    expect(assertLease).toHaveBeenCalledOnce();
    await expect(readFile(join(releasesRoot, 'current/index.html'))).rejects.toThrow();
  });

  it('preserves the prior journal and proof when the post-staging lease check fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-')); roots.push(root); const releasesRoot = join(root, 'releases'); const first = await artifact(root, 'prior'); const second = await artifact(root, 'candidate');
    await activatePublicRelease({ releasesRoot, artifact: first, jobID: 'job-prior', sequence: 1, pins }); const prior = await publicReleaseProof(releasesRoot);
    await expect(activatePublicRelease({ releasesRoot, artifact: second, jobID: 'job-candidate', sequence: 2, pins, assertLease: async () => false })).rejects.toThrow('lease');
    await expect(publicReleaseProof(releasesRoot)).resolves.toEqual(prior);
  });

  it('excludes a concurrent activation while the first process owns the volume lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-')); roots.push(root);
    const releasesRoot = join(root, 'releases'); const first = await artifact(root, 'one'); const second = await artifact(root, 'two');
    let releaseLease!: () => void; const held = new Promise<void>((done) => { releaseLease = done; });
    const firstActivation = activatePublicRelease({ releasesRoot, artifact: first, jobID: 'job-one', sequence: 1, pins, assertLease: async () => { await held; return true; } });
    await vi.waitFor(async () => expect(await readFile(join(releasesRoot, 'release-1-job-one/index.html'), 'utf8')).toBe('one'));
    await expect(activatePublicRelease({ releasesRoot, artifact: second, jobID: 'job-two', sequence: 2, pins })).rejects.toThrow('in progress');
    releaseLease();
    await expect(firstActivation).resolves.toMatchObject({ activated: true });
  });

  it('fails closed for a torn journal and restores the prior release proof after rollback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-')); roots.push(root); const releasesRoot = join(root, 'releases'); const first = await artifact(root, 'proof-one'); const second = await artifact(root, 'proof-two');
    await activatePublicRelease({ releasesRoot, artifact: first, jobID: 'job-one', sequence: 1, pins });
    const prior = await publicReleaseProof(releasesRoot);
    await expect(activatePublicRelease({ releasesRoot, artifact: second, jobID: 'job-two', sequence: 2, pins, health: async () => false })).rejects.toThrow('health');
    await expect(publicReleaseProof(releasesRoot)).resolves.toEqual(prior);
    await writeFile(join(releasesRoot, '.activation.json'), '{');
    await expect(activatePublicRelease({ releasesRoot, artifact: second, jobID: 'job-three', sequence: 3, pins })).rejects.toThrow('journal');
  });
});
