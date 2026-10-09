import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { parse } from 'parse5';
import { hasCurrentPublicRelease, publicArtifactFile, publicReleaseProof, verifyPublicArtifact } from './public-release.mjs';

const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webp': 'image/webp', '.avif': 'image/avif', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webm': 'video/webm', '.vtt': 'text/vtt',
};
const hidden = (path) => path === 'snapshot-manifest.json'
  || path === 'redirects.nginx.conf'
  || path === 'redirects.json'
  || path.split('/').some((part) => part.startsWith('.'));
const candidates = (path) => !path ? ['index.html'] : path.endsWith('/') ? [`${path}index.html`] : [path, `${path}/index.html`];
const maxScriptHashHeaderLength = 6144;

const javascriptTypes = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript',
]);

function attribute(node, name) {
  return node.attrs?.find((entry) => entry.name === name)?.value;
}

function executableScript(node) {
  if (attribute(node, 'src') !== undefined) return false;
  const typeAttribute = attribute(node, 'type');
  const declared = typeAttribute ?? attribute(node, 'language');
  if (declared === undefined || !declared.trim()) return true;
  const type = declared.trim().toLowerCase().split(';', 1)[0].trim();
  return type === 'module' || javascriptTypes.has(type) || (typeAttribute === undefined && ['javascript', 'jscript', 'ecmascript', 'livescript'].includes(type));
}

function inlineScripts(node, output) {
  for (const child of node.childNodes ?? []) {
    // Template descendants are parsed but remain inert document fragments.
    if (child.tagName === 'template') continue;
    if (child.tagName === 'script' && executableScript(child)) {
      output.push((child.childNodes ?? []).filter((entry) => entry.nodeName === '#text').map((entry) => entry.value ?? '').join(''));
      continue;
    }
    inlineScripts(child, output);
  }
}

/** Hash executable inline script text after HTML tokenization normalizes it. */
export function publicScriptHashes(body) {
  const hashes = new Set();
  const scripts = [];
  inlineScripts(parse(body.toString('utf8')), scripts);
  for (const script of scripts) hashes.add(`'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`);
  const value = [...hashes].sort().join(' ');
  return value.length <= maxScriptHashHeaderLength ? value : undefined;
}

async function initialFile(initial, path) {
  if (!initial) throw new Error('No public release is active.');
  const root = resolve(initial);
  for (const candidate of candidates(path)) {
    const file = resolve(root, candidate);
    if (!file.startsWith(`${root}/`)) continue;
    try { if ((await stat(file)).isFile()) return file; } catch {}
  }
  throw new Error('Public artifact path is unavailable.');
}

async function rootFile(releases, initial, path) {
  if (!await hasCurrentPublicRelease(releases)) return initialFile(initial, path);
  for (const candidate of candidates(path)) {
    try { return await publicArtifactFile(releases, candidate); } catch {}
  }
  throw new Error('Public artifact path is unavailable.');
}

function range(size, value) {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  let start; let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(size - suffix, 0); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  }
  return start > end || start >= size ? null : { start, end };
}

async function sendFile(req, res, file, path, status = 200) {
  const info = await stat(file);
  const contentType = mime[extname(file)] || 'application/octet-stream';
  // Hash and serve the same in-memory HTML bytes. This avoids emitting a CSP
  // hash for one file generation while streaming a later one after replacement.
  const fullHtml = contentType.startsWith('text/html') && !path.startsWith('media/') && !req.headers.range ? await readFile(file) : undefined;
  const size = fullHtml?.byteLength ?? info.size;
  const selection = status === 200 ? range(size, req.headers.range) : undefined;
  if (status === 200 && req.headers.range && !selection) {
    res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
    return;
  }
  const start = selection?.start ?? 0;
  const end = selection?.end ?? size - 1;
  const html = !selection ? fullHtml : undefined;
  const scriptHashes = html ? publicScriptHashes(html) : undefined;
  res.writeHead(selection ? 206 : status, {
    'content-type': contentType,
    'content-length': String(end - start + 1),
    'cache-control': /\.[a-f0-9]{8,}\./.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...(status === 200 ? { 'accept-ranges': 'bytes' } : {}),
    ...(selection ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    ...(scriptHashes ? { 'x-public-script-hashes': scriptHashes } : {}),
  });
  if (req.method === 'HEAD') { res.end(); return; }
  res.end((html ?? await readFile(file)).subarray(start, end + 1));
}

async function sendNotFound(req, res, releasesRoot, initialArtifactDir) {
  try {
    const file = await rootFile(releasesRoot, initialArtifactDir, '404.html');
    // A fallback belongs to the verified immutable artifact; a missing or
    // tampered fallback is an availability failure, never a plain-text page.
    await verifyPublicArtifact(dirname(file));
    await sendFile(req, res, file, '404.html', 404);
  } catch {
    res.writeHead(503, { 'cache-control': 'no-store' });
    if (req.method === 'GET') res.end('Unavailable');
    else res.end();
  }
}

/** @param {{ releasesRoot: string, initialArtifactDir?: string }} options */
export function createPublicServer({ releasesRoot, initialArtifactDir }) {
  return createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method ?? '')) {
        res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }).end();
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      const path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (path === 'healthz') {
        let proof;
        try { proof = await publicReleaseProof(releasesRoot); } catch {
          try {
            if (await hasCurrentPublicRelease(releasesRoot)) throw new Error('Current release is unhealthy.');
            await verifyPublicArtifact(initialArtifactDir); proof = { status: 'bootstrap' };
          } catch {
            res.writeHead(503, { 'cache-control': 'no-store' }).end('Unavailable');
            return;
          }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        if (req.method === 'GET') res.end(JSON.stringify(proof)); else res.end();
        return;
      }
      if (hidden(path)) { await sendNotFound(req, res, releasesRoot, initialArtifactDir); return; }
      try {
        const redirects = JSON.parse(await readFile(await rootFile(releasesRoot, initialArtifactDir, 'redirects.json'), 'utf8'));
        const redirect = redirects.find((item) => item.from.replace(/\/$/, '') === `/${path}`.replace(/\/$/, ''));
        if (redirect) {
          res.writeHead(301, { location: redirect.to, 'cache-control': 'no-store' }).end();
          return;
        }
      } catch {}
      try {
        await sendFile(req, res, await rootFile(releasesRoot, initialArtifactDir, path), path);
      } catch {
        await sendNotFound(req, res, releasesRoot, initialArtifactDir);
      }
    } catch {
      await sendNotFound(req, res, releasesRoot, initialArtifactDir);
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const server = createPublicServer({ releasesRoot: process.env.PUBLIC_RELEASES_ROOT, initialArtifactDir: process.env.PUBLIC_INITIAL_ARTIFACT_DIR });
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
}
