import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const safe = (value) => typeof value === 'string' && value && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some((part) => !part || part === '.' || part === '..');
const verifiedReleases = new Set();

async function list(root, directory = root) { const entries = await readdir(directory, { withFileTypes: true }); return (await Promise.all(entries.map(async (entry) => { const path = join(directory, entry.name); if (entry.isSymbolicLink()) throw new Error('Artifact contains a symbolic link.'); if (entry.isDirectory()) return list(root, path); return [[path.slice(root.length + 1), digest(await readFile(path))]]; }))).flat(); }
async function readJournal(root) { try { return JSON.parse(await readFile(join(root, '.activation.json'), 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw new Error('Activation journal is invalid.'); } }
async function writeJournal(root, journal) {
  const destination = join(root, '.activation.json'); const temporary = join(root, `.activation-${process.pid}-${Date.now()}.tmp`); const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(journal) + '\n'); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, destination); const directory = await open(root, 'r'); try { await directory.sync(); } finally { await directory.close(); } } finally { await rm(temporary, { force: true }); }
}
async function pointer(root) { try { const info = await lstat(join(root, 'current')); if (!info.isSymbolicLink()) throw new Error('current must be a symlink.'); return await readlink(join(root, 'current')); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; } }
async function switchPointer(root, target) { const temporary = join(root, `.current-${process.pid}-${Date.now()}`); await symlink(target, temporary); await rename(temporary, join(root, 'current')); }

// util-linux flock owns a kernel advisory lock on fd 3, inherited from the
// parent. The lock helper stays alive until its stdin closes: this avoids PID
// namespace assumptions and leaves no stale-lock recovery race.
function flock(handle) {
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['-n', '/proc/self/fd/3', '-c', 'printf locked; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe', handle.fd] });
    let error = ''; let locked = false;
    child.stderr.on('data', value => { error += value; });
    child.stdout.on('data', value => { if (!locked && value.toString().includes('locked')) { locked = true; resolve(child); } });
    child.once('error', reject);
    child.once('exit', code => { if (!locked) reject(new Error(code === 1 ? 'Another publish activation is in progress.' : `Unable to acquire activation lock: ${error.trim() || code}`)); });
  });
}
async function acquireActivationLock(root) {
  const handle = await open(join(root, '.activation.lock'), 'a', 0o600); let child; try { child = await flock(handle); } catch (error) { await handle.close(); throw error; } return async () => { child.stdin.end(); await new Promise(done => child.once('exit', done)); await handle.close(); };
}

/** Returns the identity which the public server can prove for its current release. */
export async function publicReleaseProof(releasesRoot) {
  const root = resolve(releasesRoot); const journal = await readJournal(root); const current = await pointer(root);
  // During the post-swap health check the journal is intentionally still
  // "activating".  The matching current pointer is the atomic publication
  // proof; a failed check is immediately rolled back by the activator.
  if (!journal || !['activating', 'activated'].includes(journal.state) || !current || current !== journal.release) throw new Error('No activated public release proof is available.');
  const manifest = await verifyPublicArtifact(join(root, current));
  return { jobID: journal.jobID, sequence: journal.sequence, contentHash: manifest.snapshotContentHash, versionPins: manifest.sourceVersions };
}
export async function hasCurrentPublicRelease(releasesRoot) { return Boolean(await pointer(resolve(releasesRoot))); }

/** Verifies a built immutable artifact before it can be exposed publicly. */
export async function verifyPublicArtifact(artifact, pins) {
  const root = resolve(artifact); const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Artifact must be a real directory.');
  const manifest = JSON.parse(await readFile(join(root, 'snapshot-manifest.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || !manifest.files || typeof manifest.files !== 'object') throw new Error('Artifact manifest is invalid.');
  if (typeof manifest.snapshotContentHash !== 'string' || !manifest.snapshotContentHash || !manifest.sourceVersions || typeof manifest.sourceVersions.themeVersion !== 'string' || typeof manifest.sourceVersions.engineVersion !== 'string' || typeof manifest.sourceVersions.contractVersion !== 'string') throw new Error('Artifact manifest is missing immutable version pins.');
  if (pins && (manifest.snapshotContentHash !== pins.contentHash || manifest.sourceVersions?.themeVersion !== pins.themeVersion || manifest.sourceVersions?.engineVersion !== pins.engineVersion || manifest.sourceVersions?.contractVersion !== pins.contractVersion)) throw new Error('Artifact manifest does not match immutable snapshot pins.');
  const actual = Object.fromEntries(await list(root));
  for (const [path, hash] of Object.entries(manifest.files)) if (!safe(path) || actual[path] !== hash) throw new Error(`Artifact checksum mismatch: ${path}`);
  for (const path of Object.keys(actual)) if (path !== 'snapshot-manifest.json' && !(path in manifest.files)) throw new Error(`Artifact contains unmanifested file: ${path}`);
  return manifest;
}

/** Resolves a public file under the current immutable release. Hidden and control files are never public. */
export async function publicArtifactFile(releasesRoot, pathname) {
  const root = resolve(releasesRoot);
  const requested = pathname.replace(/^\/+/, '') || 'index.html';
  if (pathname.includes('%')) throw new Error('Public artifact path is unavailable.');
  if (!safe(requested) || requested === 'snapshot-manifest.json' || requested.split('/').some((part) => part.startsWith('.'))) throw new Error('Public artifact path is unavailable.');
  const target = await pointer(root);
  if (!target || !safe(target)) throw new Error('No public release is active.');
  const release = resolve(root, target);
  if (!release.startsWith(`${root}/`)) throw new Error('Current release pointer is invalid.');
  if (!verifiedReleases.has(release)) { await verifyPublicArtifact(release); verifiedReleases.add(release); }
  const file = resolve(release, requested);
  if (!file.startsWith(`${release}/`)) throw new Error('Public artifact path is unavailable.');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Public artifact path is unavailable.');
  return file;
}

/** Atomically activates a verified release and retains a journal for crash replay. */
export async function activatePublicRelease({ releasesRoot, artifact, jobID, sequence, pins, health = async () => true, assertLease = async () => true }) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(jobID) || !Number.isInteger(sequence) || sequence < 0) throw new Error('Invalid release identity.');
  if (!pins || !['contentHash', 'themeVersion', 'engineVersion', 'contractVersion'].every((key) => typeof pins[key] === 'string' && pins[key])) throw new Error('Immutable snapshot pins are required.');
  const root = resolve(releasesRoot); await mkdir(root, { recursive: true }); const releaseLock = await acquireActivationLock(root);
  try {
  const journal = await readJournal(root);
  if (journal?.jobID === jobID && journal.sequence === sequence) {
    const manifest = await verifyPublicArtifact(journal.artifact, pins);
    if ((journal.state === 'activating' || journal.state === 'activated') && await pointer(root) === journal.release) {
      if (await assertLease() !== true) throw new Error('Publish lease is no longer current.');
      if (await health(join(root, 'current')) !== true) {
        if (journal.prior) await switchPointer(root, journal.prior); else await unlink(join(root, 'current')).catch(() => {});
        await writeJournal(root, journal.priorJournal ?? { ...journal, state: 'rolled-back' });
        throw new Error('Public health check failed.');
      }
      await writeJournal(root, { ...journal, state: 'activated' });
      return { activated: false, resumed: true, manifest };
    }
  }
  if (journal?.jobID === jobID && journal.sequence !== sequence) throw new Error('Conflicting sequence for publish job.');
  if (journal && sequence < journal.sequence) throw new Error('Older release cannot replace current release.');
  if (journal && sequence === journal.sequence && journal.jobID !== jobID) throw new Error('Conflicting publish sequence.');
  const manifest = await verifyPublicArtifact(artifact, pins); const name = `release-${sequence}-${jobID}`; const destination = join(root, name);
  try { await lstat(destination); await verifyPublicArtifact(destination, pins); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const staging = join(root, `.staging-${jobID}-${sequence}-${process.pid}-${Date.now()}`);
    try { await cp(resolve(artifact), staging, { recursive: true, dereference: false, errorOnExist: true }); await rename(staging, destination); await verifyPublicArtifact(destination, pins); } finally { await rm(staging, { recursive: true, force: true }); }
  }
  if (await assertLease() !== true) throw new Error('Publish lease is no longer current.');
  const prior = await pointer(root);
  const priorJournal = journal ? { jobID: journal.jobID, sequence: journal.sequence, artifact: journal.artifact, release: journal.release, state: 'activated' } : undefined;
  const activation = { jobID, sequence, artifact: destination, release: name, prior, priorJournal, state: 'activating' };
  await writeJournal(root, activation);
  await switchPointer(root, name);
  if (await health(join(root, 'current')) !== true) {
    if (prior) await switchPointer(root, prior); else await unlink(join(root, 'current')).catch(() => {});
    await writeJournal(root, journal ?? { ...activation, state: 'rolled-back' });
    throw new Error('Public health check failed.');
  }
  await writeJournal(root, { ...activation, state: 'activated' });
  return { activated: true, resumed: false, manifest };
  } finally { await releaseLock(); }
}
