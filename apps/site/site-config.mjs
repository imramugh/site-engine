const safeSegment = /^[A-Za-z0-9_-]+$/;

export function normalizeBasePath(value = '/') {
  if (typeof value !== 'string' || value.length === 0 || !value.startsWith('/') || value.includes('\\') || value.includes('%') || value.includes('?') || value.includes('#') || value.includes('//')) throw new Error('SITE_BASE_PATH must be a safe root-relative path.');
  const segments = value.split('/').filter(Boolean);
  if (!segments.every((segment) => safeSegment.test(segment))) throw new Error('SITE_BASE_PATH must contain only safe path segments.');
  return segments.length === 0 ? '/' : `/${segments.join('/')}/`;
}

export function normalizePublicOrigin(value = 'https://example.invalid') {
  if (typeof value !== 'string' || value.trim() !== value) throw new Error('SITE_PUBLIC_ORIGIN must be an HTTP(S) origin.');
  let url;
  try { url = new URL(value); } catch { throw new Error('SITE_PUBLIC_ORIGIN must be an HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('SITE_PUBLIC_ORIGIN must be an HTTP(S) origin without credentials, a path, query, or hash.');
  return url.origin;
}
