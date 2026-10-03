import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { SiteSnapshotSchema } from '@site-engine/contract';

const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value);
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function files(directory, root = directory) { const entries = await readdir(directory, { withFileTypes: true }); return (await Promise.all(entries.map(async entry => { if (entry.isSymbolicLink()) throw new Error('Artifact contains a symbolic link.'); return entry.isDirectory() ? files(join(directory, entry.name), root) : [[relative(root, join(directory, entry.name)), sha(await readFile(join(directory, entry.name)))]]; }))).flat(); }
export async function buildSnapshot({ input, publicOrigin, basePath = '/', outputRoot }) {
  if (!input || !publicOrigin || !outputRoot) throw new Error('input, publicOrigin, and outputRoot are required.');
  const snapshot = SiteSnapshotSchema.parse(JSON.parse(await readFile(resolve(input), 'utf8')));
  const themeVersion = process.env.SITE_THEME_VERSION; const engineVersion = process.env.SITE_ENGINE_VERSION;
  const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (!themeVersion || !engineVersion || !semver.test(themeVersion) || !semver.test(engineVersion)) throw new Error('SITE_THEME_VERSION and SITE_ENGINE_VERSION must be immutable semantic versions.');
  const root = resolve(outputRoot); const rootInfo = await lstat(root); if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('outputRoot must be a real directory.');
  // Build input and output stay in a private staging directory. Only a completed,
  // validated artifact is renamed into outputRoot under its public snapshot name.
  const job = await mkdtemp(join(root, '.snapshot-staging-')); await chmod(job, 0o700); const frozen = join(job, 'input.json'); const staged = join(job, 'artifact'); const output = join(root, `snapshot-${randomUUID()}`); await writeFile(frozen, stable(snapshot), { mode: 0o600 });
  try {
    await new Promise((resolve, reject) => { const child = spawn(process.execPath, ['node_modules/astro/bin/astro.mjs', 'build'], { cwd: new URL('..', import.meta.url), env: { ...process.env, SITE_SNAPSHOT_PATH: frozen, SITE_PUBLIC_ORIGIN: publicOrigin, SITE_BASE_PATH: basePath, SITE_PUBLIC_DEMO: 'false', SITE_OUTPUT_DIR: staged }, stdio: 'inherit' }); const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Astro build timed out.')); }, 120_000); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Astro build exited ${code}`)); }); });
    const manifest = { snapshotContentHash: sha(stable(snapshot)), sourceVersions: { contractVersion: snapshot.settings.contractVersion, themeVersion, engineVersion }, files: Object.fromEntries(await files(staged)) };
    await writeFile(join(staged, 'snapshot-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(staged, output); return { output, manifest };
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error } finally { await rm(job, { recursive: true, force: true }); }
}
