import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { publicReleaseProof } from './public-release.mjs';

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
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
export async function publishIndexNowAfterActivation({ urls, publicOrigin, basePath, fetchImpl = fetch }) {
  if (!enabled()) return { sent: false, reason: 'disabled' };
  if (basePath !== '/') return { sent: false, reason: 'preview' };
  const key = process.env.SITE_INDEXNOW_KEY;
  const endpointValue = process.env.SITE_INDEXNOW_ENDPOINT;
  if (!validKey(key) || !endpointValue) return { sent: false, reason: 'unconfigured' };
  let endpoint; let origin; let publicURLs;
  try { endpoint = allowedEndpoint(endpointValue); origin = new URL(publicOrigin); publicURLs = [...new Set(urls)].map((value) => new URL(value)); } catch { return { sent: false, reason: 'invalid-configuration' }; }
  if (origin.protocol !== 'https:' || publicURLs.some((value) => value.origin !== origin.origin || value.protocol !== 'https:')) return { sent: false, reason: 'invalid-urls' };
  const batches = Array.from({ length: Math.ceil(publicURLs.length / MAX_URLS_PER_REQUEST) }, (_, index) => publicURLs.slice(index * MAX_URLS_PER_REQUEST, (index + 1) * MAX_URLS_PER_REQUEST));
  for (const batch of batches) {
    let accepted = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response;
      try { response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ host: origin.hostname, key, keyLocation: new URL(`/${key}.txt`, origin).href, urlList: batch.map(String) }) }); } catch { return { sent: false, reason: 'outcome-unknown', batches: batches.length }; }
      if (response.status === 200 || response.status === 202) { accepted = true; break; }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) { await response.body?.cancel(); await pause(100 * (attempt + 1)); continue; }
      await response.body?.cancel(); return { sent: false, reason: 'rejected', status: response.status, batches: batches.length };
    }
    if (!accepted) return { sent: false, reason: 'rejected', batches: batches.length };
  }
  return { sent: true, batches: batches.length };
}

const sitemapURLs = xml => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
/** Stores an attempt marker before the network call. An unknown result is never
 * replayed, because a dropped acknowledgement may still have been accepted. */
export async function publishActivatedReleaseIndexNow({ releasesRoot, jobID, sequence, contentHash, publicOrigin, fetchImpl }) {
  let proof; try { proof = await publicReleaseProof(releasesRoot); } catch { return { sent: false, reason: 'not-active' }; }
  if (proof.jobID !== jobID || proof.sequence !== sequence || proof.contentHash !== contentHash) return { sent: false, reason: 'superseded' };
  const root = resolve(releasesRoot); const marker = join(root, `.indexnow-${sequence}-${jobID}.json`);
  try { await writeFile(marker, JSON.stringify({ state: 'attempting', jobID, sequence, contentHash }) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; try { return JSON.parse(await readFile(marker, 'utf8')); } catch { return { sent: false, reason: 'outcome-unknown' }; } }
  let result; try { result = await publishIndexNowAfterActivation({ urls: sitemapURLs(await readFile(join(root, 'current', 'sitemap.xml'), 'utf8')), publicOrigin, basePath: '/', fetchImpl }); } catch { result = { sent: false, reason: 'outcome-unknown' }; }
  await writeFile(marker, JSON.stringify({ ...result, jobID, sequence, contentHash }) + '\n', { mode: 0o600 }); return result;
}
