import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SiteSnapshotSchema, compatibleContractVersion } from '@site-engine/contract';
import { buildSnapshot } from './build-snapshot.mjs';
import { loadRenderer } from './renderer-adapter.mjs';
import { loadThemeRegistry, verifyThemeSelection } from './theme-registry.mjs';
import { normalizePublicOrigin } from '../site-config.mjs';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const EVIDENCE_VIEWPORT = { width: 1440, height: 900 };
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const evidenceName = 'evidence-manifest.json';
const png = /^evidence\/(live|proposed)\.png$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const versions = ['engineVersion', 'themeVersion', 'contractVersion'];
export const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value);
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const bytesHash = value => createHash('sha256').update(value).digest('hex');
class WorkerError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function claimInput(value, expectedVersions) {
  if (value?.job === null) return null;
  const { job, live, proposed, basePaths, versionPins } = value ?? {};
  if (!uuid.test(job?.id ?? '') || !/^[A-Za-z0-9_-]{16,256}$/.test(job?.leaseToken ?? '')
    || !Number.isFinite(Date.parse(job?.leaseExpiresAt)) || Date.parse(job.leaseExpiresAt) <= Date.now()
    || basePaths?.live !== 'live' || basePaths?.proposed !== 'proposed'
    || versions.some(key => typeof versionPins?.[key] !== 'string')
    || versionPins.engineVersion !== expectedVersions.engineVersion || !compatibleContractVersion(versionPins.contractVersion)) {
    throw new WorkerError('INVALID_CLAIM');
  }
  const input = { job, live: SiteSnapshotSchema.parse(live), proposed: SiteSnapshotSchema.parse(proposed), versionPins };
  const liveContractVersion = versionPins.liveContractVersion ?? versionPins.contractVersion;
  if (input.proposed.settings.contractVersion !== versionPins.contractVersion || input.live.settings.contractVersion !== liveContractVersion) throw new WorkerError('INVALID_CLAIM');
  const selectedVersion = snapshot => snapshot.settings.theme?.version;
  const proposedThemeVersion = selectedVersion(input.proposed) ?? versionPins.themeVersion;
  const liveThemeVersion = selectedVersion(input.live) ?? versionPins.liveThemeVersion ?? versionPins.themeVersion;
  if (versionPins.themeVersion !== proposedThemeVersion || ('liveThemeVersion' in versionPins && versionPins.liveThemeVersion !== liveThemeVersion)) throw new WorkerError('INVALID_CLAIM');
  input.variantPins = {
    live: { engineVersion: versionPins.engineVersion, contractVersion: liveContractVersion, themeVersion: liveThemeVersion },
    proposed: { engineVersion: versionPins.engineVersion, contractVersion: versionPins.contractVersion, themeVersion: proposedThemeVersion },
  };
  return input;
}

/** The only network destination is the operator-configured private CMS origin. */
export function createPreviewAPI({ cmsOrigin, token, fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (typeof cmsOrigin !== 'string' || !cmsOrigin) throw new WorkerError('INVALID_WORKER_CONFIGURATION');
  const origin = normalizePublicOrigin(cmsOrigin);
  if (typeof token !== 'string' || token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) throw new WorkerError('INVALID_WORKER_CONFIGURATION');
  return async (action, body = {}, signal) => {
    if (!['claim', 'renew', 'complete', 'fail'].includes(action)) throw new WorkerError('INVALID_ACTION');
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(`${origin}/api/internal/preview-jobs/${action}`, {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) { await response.body?.cancel(); throw new WorkerError(response.status === 409 ? 'LEASE_LOST' : 'CMS_UNAVAILABLE'); }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) { await response.body?.cancel(); throw new WorkerError('INVALID_CMS_RESPONSE'); }
    const reader = response.body?.getReader();
    if (!reader) throw new WorkerError('INVALID_CMS_RESPONSE');
    const chunks = []; let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new WorkerError('INVALID_CMS_RESPONSE'); }
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new WorkerError('INVALID_CMS_RESPONSE'); }
  };
}

async function fileInventory(root, directory = root) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new WorkerError('INVALID_ARTIFACT');
    if (entry.isDirectory()) Object.assign(result, await fileInventory(root, path));
    else if (entry.isFile()) result[path.slice(root.length + 1)] = bytesHash(await readFile(path));
    else throw new WorkerError('INVALID_ARTIFACT');
  }
  return result;
}

async function verifyVariant(root, snapshot, pins) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkerError('INVALID_ARTIFACT');
  const inventory = await fileInventory(root);
  const manifest = JSON.parse(await readFile(join(root, 'snapshot-manifest.json'), 'utf8'));
  delete inventory['snapshot-manifest.json'];
  if (manifest.snapshotContentHash !== hash(snapshot) || versions.some(key => manifest.sourceVersions?.[key] !== pins[key])
    || !Object.keys(inventory).includes('index.html') || canonical(inventory) !== canonical(manifest.files)
    || Object.values(inventory).some(value => !digest.test(value))) throw new WorkerError('INVALID_ARTIFACT');
  return manifest;
}

function validEvidence(value, liveHash, proposedHash) {
  if (!value || typeof value !== 'object' || value.version !== 1 || value.liveManifestHash !== liveHash || value.proposedManifestHash !== proposedHash || value.route !== '/' || canonical(value.viewport) !== canonical(EVIDENCE_VIEWPORT) || !value.screenshots || typeof value.screenshots !== 'object') throw new WorkerError('INVALID_ARTIFACT');
  for (const variant of ['live', 'proposed']) {
    const item = value.screenshots[variant];
    if (!item || typeof item !== 'object' || item.path !== `evidence/${variant}.png` || !digest.test(item.sha256) || !Number.isInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_EVIDENCE_BYTES) throw new WorkerError('INVALID_ARTIFACT');
  }
  return value;
}

async function verifyPair(root, input) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkerError('INVALID_ARTIFACT');
  const names = (await readdir(root)).sort();
  if (canonical(names) !== canonical(['evidence', evidenceName, 'live', 'proposed'])) throw new WorkerError('INVALID_ARTIFACT');
  const live = await verifyVariant(join(root, 'live'), input.live, input.variantPins.live);
  const proposed = await verifyVariant(join(root, 'proposed'), input.proposed, input.variantPins.proposed);
  const evidence = validEvidence(JSON.parse(await readFile(join(root, evidenceName), 'utf8')), live.snapshotContentHash, proposed.snapshotContentHash);
  for (const variant of ['live', 'proposed']) {
    const path = join(root, evidence.screenshots[variant].path); const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== evidence.screenshots[variant].bytes || info.size > MAX_EVIDENCE_BYTES || bytesHash(await readFile(path)) !== evidence.screenshots[variant].sha256) throw new WorkerError('INVALID_ARTIFACT');
  }
  return { liveManifestHash: live.snapshotContentHash, proposedManifestHash: proposed.snapshotContentHash, evidenceManifest: evidence, artifactDigest: hash({ live, proposed, evidence }) };
}

export async function captureEvidence(pair, input, signal) {
  const root = resolve(pair); let server;
  const close = () => server && new Promise(done => server.close(done));
  try {
    server = createServer(async (request, response) => {
      const raw = new URL(request.url ?? '/', 'http://loopback'); const clean = raw.pathname.replace(/^\/+/, '');
      if (!request.headers.host || request.method !== 'GET' || /(?:^|\/)\.{1,2}(?:\/|$)|%|\\/.test(clean)) { response.writeHead(404).end(); return; }
      const file = resolve(root, clean); if (!file.startsWith(`${root}/`)) { response.writeHead(404).end(); return; }
      try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(); response.writeHead(200).end(await readFile(file)); } catch { response.writeHead(404).end(); }
    });
    await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
    const port = server.address().port; const { chromium } = await import('@playwright/test'); const browser = await chromium.launch({ headless: true });
    try { const context = await browser.newContext({ viewport: EVIDENCE_VIEWPORT, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.route('**/*', route => new URL(route.request().url()).origin === `http://127.0.0.1:${port}` ? route.continue() : route.abort());
      const shots = {};
      for (const variant of ['live', 'proposed']) { const page = await context.newPage(); await page.goto(`http://127.0.0.1:${port}/${variant}/`, { waitUntil: 'networkidle', timeout: 30_000 }); await page.evaluate(async () => { await document.fonts.ready; }); const data = await page.screenshot({ type: 'png' }); await page.close(); if (data.length > MAX_EVIDENCE_BYTES) throw new WorkerError('EVIDENCE_TOO_LARGE'); const path = `evidence/${variant}.png`; await writeFile(join(root, path), data, { mode: 0o600 }); shots[variant] = { path, sha256: bytesHash(data), bytes: data.length }; }
      await context.close(); const evidence = { version: 1, route: '/', viewport: EVIDENCE_VIEWPORT, liveManifestHash: hash(input.live), proposedManifestHash: hash(input.proposed), screenshots: shots }; await writeFile(join(root, evidenceName), canonical(evidence), { mode: 0o600 }); return evidence;
    } finally { await browser.close(); }
  } finally { await close(); }
}

async function purgeExpiredArtifacts(root) {
  const days = Number(process.env.PREVIEW_EVIDENCE_RETENTION_DAYS ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new WorkerError('INVALID_WORKER_CONFIGURATION');
  const cutoff = Date.now() - days * 86_400_000; let removed = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (removed >= 20 || !uuid.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const target = join(root, entry.name); const info = await stat(target);
    if (info.mtimeMs <= cutoff) { await rm(target, { recursive: true, force: false }); removed += 1; }
  }
}

/** One claim is rendered serially. Lease loss cancels Astro and prevents completion. */
export async function runPreviewOnce({ api, artifactRoot, publicOrigin, versionPins, registry = new Map(), render = buildSnapshot, capture = captureEvidence, signal, heartbeatMs = 10_000 }) {
  const input = claimInput(await api('claim', {}, signal), versionPins);
  if (!input) return false;
  verifyThemeSelection(input.live, registry); verifyThemeSelection(input.proposed, registry);
  const identity = { id: input.job.id, leaseToken: input.job.leaseToken };
  const origin = normalizePublicOrigin(publicOrigin);
  const root = resolve(artifactRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new WorkerError('INVALID_ARTIFACT_ROOT');
  await purgeExpiredArtifacts(root);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let renewal; let timer; let leaseLost = false; let stopped = false;
  const heartbeat = () => {
    timer = setTimeout(() => {
      renewal = api('renew', identity, controller.signal).then(() => { if (!stopped) heartbeat(); })
        .catch(() => { leaseLost = true; controller.abort(); });
    }, heartbeatMs);
  };
  const stopHeartbeat = async () => { stopped = true; clearTimeout(timer); await renewal; };
  heartbeat();
  let scratch;
  try {
    const destination = join(root, input.job.id);
    let evidence;
    try { await lstat(destination); evidence = await verifyPair(destination, input); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!evidence) {
      scratch = await mkdtemp(join(root, '.preview-build-'));
      await chmod(scratch, 0o700);
      const pair = join(scratch, 'pair'); await mkdir(pair, { mode: 0o700 });
      for (const variant of ['live', 'proposed']) {
        const inputPath = join(scratch, `${variant}.json`);
        await writeFile(inputPath, canonical(input[variant]), { mode: 0o600 });
        if (controller.signal.aborted) throw new WorkerError(leaseLost ? 'LEASE_LOST' : 'BUILD_CANCELLED');
        const result = await render({ input: inputPath, outputRoot: scratch, publicOrigin: origin, basePath: `/preview/changes/${input.job.id}/${variant}/`, themeSelection: input[variant].settings.theme, versionPins: input.variantPins[variant], signal: controller.signal });
        if (controller.signal.aborted) throw new WorkerError(leaseLost ? 'LEASE_LOST' : 'BUILD_CANCELLED');
        const output = resolve(result.output);
        if (!output.startsWith(`${scratch}/snapshot-`) || output.slice(scratch.length + 1).includes('/')) throw new WorkerError('INVALID_ARTIFACT');
        await verifyVariant(output, input[variant], input.variantPins[variant]);
        await rename(output, join(pair, variant));
      }
      await capture(pair, input, controller.signal);
      evidence = await verifyPair(pair, input);
      if (controller.signal.aborted) throw new WorkerError(leaseLost ? 'LEASE_LOST' : 'BUILD_CANCELLED');
      await rename(pair, destination);
    }
    await stopHeartbeat();
    if (controller.signal.aborted) throw new WorkerError(leaseLost ? 'LEASE_LOST' : 'BUILD_CANCELLED');
    await api('complete', { ...identity, ...evidence }, controller.signal);
    return true;
  } catch (error) {
    await stopHeartbeat();
    if (!leaseLost) {
      const errorCode = error instanceof WorkerError ? error.code : controller.signal.aborted ? 'BUILD_CANCELLED' : 'BUILD_FAILED';
      const diagnostics = Array.isArray(error?.diagnostics) ? error.diagnostics.slice(0, 100).filter((item) => item && typeof item.code === 'string' && typeof item.path === 'string' && typeof item.message === 'string').map(({ code, path, pageId, blockId, message }) => ({ code: code.slice(0, 64), path: path.slice(0, 300), ...(typeof pageId === 'string' && uuid.test(pageId) ? { pageId } : {}), ...(typeof blockId === 'string' && uuid.test(blockId) ? { blockId } : {}), message: message.slice(0, 500) })) : undefined;
      try { await api('fail', { ...identity, errorCode, ...(diagnostics ? { diagnostics } : {}) }); } catch { /* The expired lease is reclaimable by the next worker. */ }
    }
    throw new WorkerError(leaseLost ? 'LEASE_LOST' : error instanceof WorkerError ? error.code : 'BUILD_FAILED');
  } finally {
    await stopHeartbeat(); signal?.removeEventListener('abort', abort);
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = createPreviewAPI({ cmsOrigin: process.env.PREVIEW_CMS_ORIGIN, token: process.env.PREVIEW_WORKER_TOKEN });
  const artifactRoot = process.env.PREVIEW_ARTIFACT_ROOT;
  if (!process.env.SITE_PUBLIC_ORIGIN) throw new WorkerError('INVALID_WORKER_CONFIGURATION');
  const publicOrigin = normalizePublicOrigin(process.env.SITE_PUBLIC_ORIGIN);
  const versionPins = { engineVersion: process.env.SITE_ENGINE_VERSION, contractVersion: process.env.SITE_CONTRACT_VERSION };
  if (!artifactRoot || Object.values(versionPins).some(value => !value)) throw new WorkerError('INVALID_WORKER_CONFIGURATION');
  const registry = await loadThemeRegistry();
  const render = await loadRenderer({ genericRenderer: buildSnapshot });
  const controller = new AbortController();
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => controller.abort());
  while (!controller.signal.aborted) {
    try { await runPreviewOnce({ api, artifactRoot, publicOrigin, versionPins, registry, render, signal: controller.signal }); }
    catch (error) { console.error(`Preview worker: ${error instanceof WorkerError ? error.code : 'WORKER_FAILED'}`); }
    if (!controller.signal.aborted) await new Promise(resolveDelay => { const timer = setTimeout(done, 2_000); function done() { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolveDelay(); } controller.signal.addEventListener('abort', done, { once: true }); });
  }
}
