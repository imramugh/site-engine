import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { loadRenderer } from './renderer-adapter.mjs';
import { buildSnapshot } from './build-snapshot.mjs';
import { createPublishAPI, runPublishOnce } from './run-publish-worker.mjs';
import { loadThemeRegistry } from './theme-registry.mjs';
import { createReplayGuard, handlePublishWebhook } from './publish-webhook.mjs';

export function createPublishWebhookServer(options) {
  const replay = options.replay ?? createReplayGuard();
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') { response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end('{"status":"ok"}'); return; }
    try {
      const controller = new AbortController(); request.once('aborted', () => controller.abort()); response.once('close', () => { if (!response.writableEnded) controller.abort(); });
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : Readable.toWeb(request);
      const result = await handlePublishWebhook(new Request(`http://internal${request.url}`, { method: request.method, headers: request.headers, body, duplex: body ? 'half' : undefined, signal: controller.signal }), { ...options, replay, signal: controller.signal });
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end('{"error":"WEBHOOK_BODY_INVALID"}');
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const versionPins = { engineVersion: process.env.SITE_ENGINE_VERSION, contractVersion: process.env.SITE_CONTRACT_VERSION };
  if (!process.env.PUBLISH_WEBHOOK_SECRET || Object.values(versionPins).some(value => !value)) throw new Error('INVALID_RECEIVER_CONFIGURATION');
  const [registry, render] = await Promise.all([loadThemeRegistry(), loadRenderer({ genericRenderer: buildSnapshot })]);
  const api = createPublishAPI({ cmsOrigin: process.env.PUBLISH_CMS_ORIGIN, token: process.env.PUBLISH_WORKER_TOKEN });
  const server = createPublishWebhookServer({ secret: process.env.PUBLISH_WEBHOOK_SECRET, run: (claimed, signal) => runPublishOnce({ api, claimed, buildRoot: process.env.PUBLISH_BUILD_ROOT, releasesRoot: process.env.PUBLISH_RELEASES_ROOT, publicOrigin: process.env.SITE_PUBLIC_ORIGIN, healthOrigin: process.env.PUBLISH_HEALTH_ORIGIN || process.env.SITE_PUBLIC_ORIGIN, versionPins, registry, render, signal }) });
  server.listen(Number(process.env.PUBLISH_WEBHOOK_PORT || 3002), '0.0.0.0');
}
