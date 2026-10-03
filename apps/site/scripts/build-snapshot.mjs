import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { SiteSnapshotSchema } from '@site-engine/contract';
import { normalizeBasePath, normalizePublicOrigin } from '../site-config.mjs';
import { writeIndexNowVerificationFile } from './indexnow.mjs';
import { nginxRedirectInclude } from './redirect-artifact.mjs';

const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value);
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function files(directory, root = directory) { const entries = await readdir(directory, { withFileTypes: true }); return (await Promise.all(entries.map(async entry => { if (entry.isSymbolicLink()) throw new Error('Artifact contains a symbolic link.'); return entry.isDirectory() ? files(join(directory, entry.name), root) : [[relative(root, join(directory, entry.name)), sha(await readFile(join(directory, entry.name)))]]; }))).flat(); }
const safeFilename = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(value);
function referencedMedia(snapshot) {
  const ids = new Set();
  const collect = (value) => {
    if (Array.isArray(value)) return value.forEach(collect);
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'mediaId' || key === 'posterMediaId' || key === 'captionsMediaId') && typeof item === 'string') ids.add(item);
      else if (key === 'mediaIds' && Array.isArray(item)) item.forEach((id) => typeof id === 'string' && ids.add(id));
      else collect(item);
    }
  };
  snapshot.pages.filter((page) => page.status === 'published').forEach((page) => collect(page.blocks.filter((block) => !block.hidden)));
  if (snapshot.settings.logo) ids.add(snapshot.settings.logo.id);
  return ids;
}
async function copyReferencedMedia(snapshot, output) {
  const references = new Set(referencedMedia(snapshot));
  if (!references.size) { await rm(join(output, 'media'), { recursive: true, force: true }); return; }
  const bundledRoot = resolve(new URL('../public/media/', import.meta.url).pathname);
  const uploadedRoot = resolve(process.env.SITE_MEDIA_DIR || bundledRoot);
  const destination = join(output, 'media'); await rm(destination, { recursive: true, force: true }); await mkdir(destination, { recursive: true });
  const copied = new Map();
  const referenced = snapshot.media.filter((item) => references.has(item.id));
  if (snapshot.settings.logo) referenced.push(snapshot.settings.logo);
  for (const id of references) if (!referenced.some(media => media.id === id)) throw new Error(`Referenced media is absent from snapshot: ${id}`);
  for (const media of referenced) {
    const selections = [{ filename: media.filename, sha256: media.sha256 }, ...Object.values(media.variants ?? {})];
    for (const selection of selections) {
      if (!safeFilename(selection.filename)) throw new Error(`Referenced media filename is unsafe: ${String(selection.filename)}`);
      // Legacy bundled fixtures lack a digest. They can only resolve from the
      // immutable source image, never from the mutable upload directory.
      const root = selection.sha256 ? uploadedRoot : bundledRoot;
      const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Media root must be a real directory.');
      const source = resolve(root, selection.filename); if (!source.startsWith(`${root}/`)) throw new Error('Referenced media path escapes SITE_MEDIA_DIR.');
      let sourceInfo; try { sourceInfo = await lstat(source); } catch (error) { if (error?.code === 'ENOENT') throw new Error(`Referenced media file is unavailable: ${selection.filename}`); throw error; }
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`Referenced media file is unavailable: ${selection.filename}`);
      const bytes = await readFile(source, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
      const digest = sha(bytes);
      if (selection.sha256 && digest !== selection.sha256) throw new Error(`Referenced media checksum mismatch: ${selection.filename}`);
      const prior = copied.get(selection.filename); if (prior && prior !== digest) throw new Error(`Referenced media filename collision: ${selection.filename}`);
      if (!prior) { await writeFile(join(destination, selection.filename), bytes, { flag: 'wx', mode: 0o644 }); copied.set(selection.filename, digest); }
    }
  }
}
function terminate(child, signal) {
  if (child.exitCode !== null) return;
  try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { child.kill(signal); }
}
function runAstro({ frozen, publicOrigin, basePath, staged, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let timedOut = false; let aborted = false; let forceTimer;
    const child = spawn(process.execPath, ['node_modules/astro/bin/astro.mjs', 'build'], { cwd: new URL('..', import.meta.url), detached: process.platform !== 'win32', env: { ...process.env, SITE_SNAPSHOT_PATH: frozen, SITE_PUBLIC_ORIGIN: publicOrigin, SITE_BASE_PATH: basePath, SITE_PUBLIC_DEMO: 'false', SITE_OUTPUT_DIR: staged, SITE_CACHE_DIR: join(staged, '..', 'cache') }, stdio: 'inherit' });
    const stop = () => { terminate(child, 'SIGTERM'); forceTimer ??= setTimeout(() => terminate(child, 'SIGKILL'), 5_000); };
    const abort = () => { aborted = true; stop(); };
    const cleanup = () => { clearTimeout(timeout); clearTimeout(forceTimer); signal?.removeEventListener('abort', abort); };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('exit', (code, exitSignal) => { cleanup(); if (aborted) reject(new Error('Astro build was cancelled.')); else if (timedOut) reject(new Error(`Astro build timed out after ${timeoutMs}ms (${exitSignal ?? code ?? 'unknown'}).`)); else code === 0 ? resolve() : reject(new Error(`Astro build exited ${code}`)); });
  });
}
/** @param {{ input: string, publicOrigin: string, basePath?: string, outputRoot: string, timeoutMs?: number, signal?: AbortSignal }} options */
export async function buildSnapshot({ input, publicOrigin, basePath = '/', outputRoot, timeoutMs = 120_000, signal }) {
  if (signal?.aborted) throw new Error('Astro build was cancelled.');
  if (!input || !publicOrigin || !outputRoot) throw new Error('input, publicOrigin, and outputRoot are required.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive number.');
  const normalizedOrigin = normalizePublicOrigin(publicOrigin); const normalizedBase = normalizeBasePath(basePath);
  const snapshot = SiteSnapshotSchema.parse(JSON.parse(await readFile(resolve(input), 'utf8')));
  const themeVersion = process.env.SITE_THEME_VERSION; const engineVersion = process.env.SITE_ENGINE_VERSION;
  const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (!themeVersion || !engineVersion || !semver.test(themeVersion) || !semver.test(engineVersion)) throw new Error('SITE_THEME_VERSION and SITE_ENGINE_VERSION must be immutable semantic versions.');
  const root = resolve(outputRoot); const rootInfo = await lstat(root); if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('outputRoot must be a real directory.');
  // Build input and output stay in a private staging directory. Only a completed,
  // validated artifact is renamed into outputRoot under its public snapshot name.
  const job = await mkdtemp(join(root, '.snapshot-staging-')); await chmod(job, 0o700); const frozen = join(job, 'input.json'); const staged = join(job, 'artifact'); const output = join(root, `snapshot-${randomUUID()}`); await writeFile(frozen, stable(snapshot), { mode: 0o600 });
  try {
    await runAstro({ frozen, publicOrigin: normalizedOrigin, basePath: normalizedBase, staged, timeoutMs, signal });
    await copyReferencedMedia(snapshot, staged);
    await writeIndexNowVerificationFile({ output: staged });
    // This is consumed by the edge deployment adapter only after approval. It
    // contains no draft CMS data and is deterministic for a snapshot hash.
    await writeFile(join(staged, 'redirects.nginx.conf'), nginxRedirectInclude(snapshot), { mode: 0o644 });
    const manifest = { snapshotContentHash: sha(stable(snapshot)), sourceVersions: { contractVersion: snapshot.settings.contractVersion, themeVersion, engineVersion }, files: Object.fromEntries(await files(staged)) };
    await writeFile(join(staged, 'snapshot-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(staged, output);
    return { output, manifest };
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error } finally { await rm(job, { recursive: true, force: true }); }
}
