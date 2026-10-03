import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  if (!themeVersion || !engineVersion || ['starter', 'engine'].includes(themeVersion) || ['starter', 'engine'].includes(engineVersion)) throw new Error('SITE_THEME_VERSION and SITE_ENGINE_VERSION must identify immutable sources.');
  const root = resolve(outputRoot); const rootInfo = await lstat(root); if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('outputRoot must be a real directory.');
  const output = await mkdtemp(join(root, 'snapshot-')); const frozen = join(output, '.input.json'); await writeFile(frozen, stable(snapshot));
  try {
    await new Promise((resolve, reject) => { const child = spawn(process.execPath, ['node_modules/astro/astro.js', 'build'], { cwd: new URL('..', import.meta.url), env: { ...process.env, SITE_SNAPSHOT_PATH: frozen, SITE_PUBLIC_ORIGIN: publicOrigin, SITE_BASE_PATH: basePath, SITE_PUBLIC_DEMO: 'false', SITE_OUTPUT_DIR: output }, stdio: 'inherit' }); const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Astro build timed out.')); }, 120_000); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Astro build exited ${code}`)); }); });
    const manifest = { snapshotContentHash: sha(stable(snapshot)), sourceVersions: { contractVersion: snapshot.settings.contractVersion, themeVersion, engineVersion }, files: Object.fromEntries((await files(output)).filter(([name]) => name !== '.input.json')) };
    await writeFile(join(output, 'snapshot-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`); return { output, manifest };
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error }
}
