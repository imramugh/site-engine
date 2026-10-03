import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SiteSnapshotSchema } from '@site-engine/contract';
import { buildSnapshot } from './build-snapshot.mjs';
import { normalizePublicOrigin } from '../site-config.mjs';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
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
    || versions.some(key => typeof versionPins?.[key] !== 'string' || versionPins[key] !== expectedVersions[key])) {
    throw new WorkerError('INVALID_CLAIM');
  }
  const input = { job, live: SiteSnapshotSchema.parse(live), proposed: SiteSnapshotSchema.parse(proposed), versionPins };
  if ([input.live, input.proposed].some(snapshot => snapshot.settings.contractVersion !== versionPins.contractVersion)) throw new WorkerError('INVALID_CLAIM');
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

async function verifyPair(root, input) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkerError('INVALID_ARTIFACT');
  const names = (await readdir(root)).sort();
  if (canonical(names) !== canonical(['live', 'proposed'])) throw new WorkerError('INVALID_ARTIFACT');
  const live = await verifyVariant(join(root, 'live'), input.live, input.versionPins);
  const proposed = await verifyVariant(join(root, 'proposed'), input.proposed, input.versionPins);
  return { liveManifestHash: live.snapshotContentHash, proposedManifestHash: proposed.snapshotContentHash, artifactDigest: hash({ live, proposed }) };
}

/** One claim is rendered serially. Lease loss cancels Astro and prevents completion. */
export async function runPreviewOnce({ api, artifactRoot, publicOrigin, versionPins, render = buildSnapshot, signal, heartbeatMs = 10_000 }) {
  const input = claimInput(await api('claim', {}, signal), versionPins);
  if (!input) return false;
  const identity = { id: input.job.id, leaseToken: input.job.leaseToken };
  const origin = normalizePublicOrigin(publicOrigin);
  const root = resolve(artifactRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new WorkerError('INVALID_ARTIFACT_ROOT');
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
        const result = await render({ input: inputPath, outputRoot: scratch, publicOrigin: origin, basePath: `/preview/changes/${input.job.id}/${variant}/`, signal: controller.signal });
        if (controller.signal.aborted) throw new WorkerError(leaseLost ? 'LEASE_LOST' : 'BUILD_CANCELLED');
        const output = resolve(result.output);
        if (!output.startsWith(`${scratch}/snapshot-`) || output.slice(scratch.length + 1).includes('/')) throw new WorkerError('INVALID_ARTIFACT');
        await verifyVariant(output, input[variant], input.versionPins);
        await rename(output, join(pair, variant));
      }
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
      try { await api('fail', { ...identity, errorCode }); } catch { /* The expired lease is reclaimable by the next worker. */ }
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
  const versionPins = { engineVersion: process.env.SITE_ENGINE_VERSION, themeVersion: process.env.SITE_THEME_VERSION, contractVersion: process.env.SITE_CONTRACT_VERSION };
  if (!artifactRoot || versions.some(key => !versionPins[key])) throw new WorkerError('INVALID_WORKER_CONFIGURATION');
  const controller = new AbortController();
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => controller.abort());
  while (!controller.signal.aborted) {
    try { await runPreviewOnce({ api, artifactRoot, publicOrigin, versionPins, signal: controller.signal }); }
    catch (error) { console.error(`Preview worker: ${error instanceof WorkerError ? error.code : 'WORKER_FAILED'}`); }
    if (!controller.signal.aborted) await new Promise(resolveDelay => { const timer = setTimeout(done, 2_000); function done() { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolveDelay(); } controller.signal.addEventListener('abort', done, { once: true }); });
  }
}
