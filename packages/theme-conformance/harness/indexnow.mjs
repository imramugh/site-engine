import { lstat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MAX_URLS_PER_REQUEST = 10_000;
const enabled = () => process.env.SITE_INDEXNOW_ENABLED === 'true' && process.env.NODE_ENV === 'production';

function validKey(key) { return typeof key === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(key); }

function allowedEndpoint(value) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/indexnow' || endpoint.search || endpoint.hash) throw new Error('SITE_INDEXNOW_ENDPOINT must be an HTTPS /indexnow endpoint.');
  const hosts = (process.env.SITE_INDEXNOW_ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean);
  if (!hosts.includes(endpoint.hostname)) throw new Error('SITE_INDEXNOW_ENDPOINT host is not allowlisted.');
  return endpoint;
}

/** The verification file is public by design and must be deployed before activation. */
export async function writeIndexNowVerificationFile({ output, key = process.env.SITE_INDEXNOW_KEY }) {
  if (!validKey(key)) return false;
  const root = resolve(output); const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('IndexNow verification output must be a real directory.');
  await writeFile(join(root, `${key}.txt`), key, { mode: 0o644, flag: 'wx' });
  return true;
}

/** Invoke only after the immutable artifact is activated at its public origin. */
export async function publishIndexNowAfterActivation({ urls, publicOrigin, basePath }) {
  if (!enabled()) return { sent: false, reason: 'disabled' };
  if (basePath !== '/') return { sent: false, reason: 'preview' };
  const key = process.env.SITE_INDEXNOW_KEY;
  const endpointValue = process.env.SITE_INDEXNOW_ENDPOINT;
  if (!validKey(key) || !endpointValue) return { sent: false, reason: 'unconfigured' };
  const endpoint = allowedEndpoint(endpointValue);
  const origin = new URL(publicOrigin);
  const publicURLs = [...new Set(urls)].map((value) => new URL(value));
  if (publicURLs.some((value) => value.origin !== origin.origin || value.protocol !== 'https:')) throw new Error('IndexNow URLs must use the configured HTTPS public origin.');
  const batches = Array.from({ length: Math.ceil(publicURLs.length / MAX_URLS_PER_REQUEST) }, (_, index) => publicURLs.slice(index * MAX_URLS_PER_REQUEST, (index + 1) * MAX_URLS_PER_REQUEST));
  for (const batch of batches) {
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: origin.hostname, key, keyLocation: new URL(`/${key}.txt`, origin).href, urlList: batch.map(String) }) });
    if (!response.ok) throw new Error(`IndexNow rejected the activation hook (${response.status}).`);
  }
  return { sent: true, batches: batches.length };
}
