const enabled = () => process.env.SITE_INDEXNOW_ENABLED === 'true' && process.env.NODE_ENV === 'production';

function allowedEndpoint(value) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/indexnow' || endpoint.search || endpoint.hash) throw new Error('SITE_INDEXNOW_ENDPOINT must be an HTTPS /indexnow endpoint.');
  const hosts = (process.env.SITE_INDEXNOW_ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean);
  if (!hosts.includes(endpoint.hostname)) throw new Error('SITE_INDEXNOW_ENDPOINT host is not allowlisted.');
  return endpoint;
}

/** Sends only production, root-mounted public URLs to an explicitly allowlisted endpoint. */
export async function publishIndexNow({ urls, publicOrigin, basePath }) {
  if (!enabled()) return { sent: false, reason: 'disabled' };
  if (basePath !== '/') return { sent: false, reason: 'preview' };
  const key = process.env.SITE_INDEXNOW_KEY;
  const endpointValue = process.env.SITE_INDEXNOW_ENDPOINT;
  if (!key || !/^[A-Za-z0-9-]{8,128}$/.test(key) || !endpointValue) return { sent: false, reason: 'unconfigured' };
  const endpoint = allowedEndpoint(endpointValue);
  const origin = new URL(publicOrigin);
  const publicURLs = urls.map((value) => new URL(value));
  if (publicURLs.some((value) => value.origin !== origin.origin || value.protocol !== 'https:')) throw new Error('IndexNow URLs must use the configured HTTPS public origin.');
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: origin.hostname, key, keyLocation: new URL(`/${key}.txt`, origin).href, urlList: publicURLs.map(String) }) });
  if (!response.ok) throw new Error(`IndexNow rejected the publish hook (${response.status}).`);
  return { sent: true, status: response.status };
}
