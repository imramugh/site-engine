import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SiteSnapshotSchema } from '@site-engine/contract';
import { buildSnapshot } from './build-snapshot.mjs';
import { loadRenderer } from './renderer-adapter.mjs';
import { activatePublicRelease, verifyPublicArtifact } from './public-release.mjs';
import { normalizePublicOrigin } from '../site-config.mjs';

const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a, b], [c, d]) => a.localeCompare(c)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class WorkerError extends Error { constructor(code) { super(code); this.code = code; } }

export function createPublishAPI({ cmsOrigin, token, fetchImpl = fetch, timeoutMs = 10_000 }) {
  const origin = normalizePublicOrigin(cmsOrigin); if (typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)) throw new WorkerError('INVALID_WORKER_CONFIGURATION');
  return async (action, body = {}, signal) => {
    const timeout = AbortSignal.timeout(timeoutMs); const response = await fetchImpl(`${origin}/api/internal/publish-jobs/${action}`, { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) { await response.body?.cancel(); throw new WorkerError(response.status === 409 ? 'LEASE_LOST' : 'CMS_UNAVAILABLE'); }
    try { return await response.json(); } catch { throw new WorkerError('INVALID_CMS_RESPONSE'); }
  };
}
function claim(value, pins) {
  if (value?.job === null) return null; const job = value?.job;
  if (!uuid.test(job?.id ?? '') || typeof job?.leaseToken !== 'string' || !Number.isFinite(Date.parse(job?.leaseExpiresAt)) || Date.parse(job.leaseExpiresAt) <= Date.now() || !value?.contentHash || Object.keys(pins).some(key => value?.versionPins?.[key] !== pins[key])) throw new WorkerError('INVALID_CLAIM');
  const snapshot = SiteSnapshotSchema.parse(value.snapshot); if (hash(snapshot) !== value.contentHash || snapshot.settings.contractVersion !== pins.contractVersion) throw new WorkerError('INVALID_CLAIM');
  return { job, snapshot, pins: { contentHash: value.contentHash, ...pins } };
}
function sameProof(proof, expected) { return proof?.jobID === expected.jobID && proof?.sequence === expected.sequence && proof?.contentHash === expected.contentHash && Object.keys(expected.versionPins).every(key => proof?.versionPins?.[key] === expected.versionPins[key]); }
async function externalHealthProbe(origin, expected, signal) {
  try { const response = await fetch(`${origin}/healthz`, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), headers: { accept: 'application/json' } }); if (!response.ok) return false; return sameProof(await response.json(), expected); } catch { return false; }
}
function validLease(lease, identity, signal) { return !signal?.aborted && lease?.id === identity.id && lease?.leaseToken === identity.leaseToken && Number.isFinite(Date.parse(lease?.leaseExpiresAt ?? '')) && Date.parse(lease.leaseExpiresAt) > Date.now(); }
/** @param {{ api: (action: string, body?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>, buildRoot: string, releasesRoot: string, publicOrigin: string, healthOrigin?: string, versionPins: Record<string, string>, render?: typeof buildSnapshot, signal?: AbortSignal, healthProbe?: (proof: { jobID: string, sequence: number, contentHash: string, versionPins: Record<string, string> }) => Promise<boolean> }} options */
export async function runPublishOnce({ api, buildRoot, releasesRoot, publicOrigin, healthOrigin = publicOrigin, versionPins, render = buildSnapshot, signal, healthProbe }) {
  const input = claim(await api('claim', {}, signal), versionPins); if (!input) return false;
  const identity = { id: input.job.id, leaseToken: input.job.leaseToken }; let scratch;
  try {
    let artifact; let manifest;
    const prior = join(resolve(releasesRoot), `release-${input.job.sequence}-${identity.id}`);
    try { await lstat(prior); manifest = await verifyPublicArtifact(prior, input.pins); artifact = prior; }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(buildRoot, { recursive: true }); scratch = await mkdtemp(join(resolve(buildRoot), '.publish-build-'));
      const source = join(scratch, 'snapshot.json'); await writeFile(source, stable(input.snapshot));
      const built = await render({ input: source, outputRoot: scratch, publicOrigin: normalizePublicOrigin(publicOrigin), basePath: '/', versionPins, signal });
      manifest = await verifyPublicArtifact(built.output, input.pins); artifact = built.output;
    }
    const expectedProof = { jobID: identity.id, sequence: input.job.sequence, contentHash: input.pins.contentHash, versionPins };
    const probe = healthProbe ?? ((expected) => externalHealthProbe(normalizePublicOrigin(healthOrigin), expected, signal));
    await activatePublicRelease({ releasesRoot, artifact, jobID: identity.id, sequence: input.job.sequence, pins: input.pins, health: () => probe(expectedProof), assertLease: async () => {
      const renewed = await api('renew', identity, signal); if (!validLease(renewed?.job, identity, signal)) throw new WorkerError('LEASE_LOST'); return true;
    } });
    const evidence = { digest: hash(manifest), sourceContentHash: input.pins.contentHash, ...versionPins, checks: [{ name: 'artifact-integrity', status: 'passed' }, { name: 'public-health', status: 'passed' }] };
    await api('complete', { ...identity, artifact: evidence }, signal); return true;
  } catch (error) {
    if (error?.code !== 'LEASE_LOST') { try { await api('fail', { ...identity, errorCode: error?.code ?? 'BUILD_FAILED' }, signal); } catch {} }
    throw error instanceof WorkerError ? error : new WorkerError('BUILD_FAILED');
  }
  finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController(); for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => controller.abort());
  const versionPins = { themeVersion: process.env.SITE_THEME_VERSION, engineVersion: process.env.SITE_ENGINE_VERSION, contractVersion: process.env.SITE_CONTRACT_VERSION };
  const render = await loadRenderer({ genericRenderer: buildSnapshot });
  const api = createPublishAPI({ cmsOrigin: process.env.PUBLISH_CMS_ORIGIN, token: process.env.PUBLISH_WORKER_TOKEN });
  while (!controller.signal.aborted) { try { await runPublishOnce({ api, buildRoot: process.env.PUBLISH_BUILD_ROOT, releasesRoot: process.env.PUBLISH_RELEASES_ROOT, publicOrigin: process.env.SITE_PUBLIC_ORIGIN, healthOrigin: process.env.PUBLISH_HEALTH_ORIGIN || process.env.SITE_PUBLIC_ORIGIN, versionPins, render, signal: controller.signal }); } catch (error) { console.error(`Publish worker: ${error.code ?? 'WORKER_FAILED'}`); } await new Promise(done => setTimeout(done, 2_000)); }
}
