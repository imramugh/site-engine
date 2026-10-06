import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PUBLISH_WEBHOOK_PATH = '/internal/publish-build';
export const MAX_PUBLISH_WEBHOOK_BODY_BYTES = 1024 * 1024;

export class PublishWebhookError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }

function secret(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) < 32 || /[\r\n]/.test(value)) throw new PublishWebhookError('INVALID_WEBHOOK_CONFIGURATION', 500);
  return value;
}
function signature(secretValue, timestamp, nonce, body) { return createHmac('sha256', secret(secretValue)).update(`${timestamp}.${nonce}.`).update(body).digest('hex'); }
function equal(left, right) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }

export function signPublishWebhook({ secret: secretValue, timestamp, nonce, body }) {
  return `sha256=${signature(secretValue, timestamp, nonce, body)}`;
}

export function verifyPublishWebhook({ secret: secretValue, timestamp, nonce, signature: supplied, body, now = Date.now(), maxAgeMs = 60_000 }) {
  const sentAt = Number(timestamp);
  if (!Number.isSafeInteger(sentAt) || Math.abs(now - sentAt) > maxAgeMs) throw new PublishWebhookError('WEBHOOK_TIMESTAMP_EXPIRED', 401);
  if (!uuid.test(nonce ?? '')) throw new PublishWebhookError('WEBHOOK_NONCE_INVALID', 401);
  if (typeof supplied !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(supplied)) throw new PublishWebhookError('WEBHOOK_SIGNATURE_INVALID', 401);
  if (!equal(supplied, signPublishWebhook({ secret: secretValue, timestamp, nonce, body }))) throw new PublishWebhookError('WEBHOOK_SIGNATURE_INVALID', 401);
}

export function createReplayGuard({ now = () => Date.now(), maxEntries = 10_000 } = {}) {
  const nonces = new Map();
  return {
    use(nonce, expiresAt) {
      const current = now();
      for (const [key, expiry] of nonces) if (expiry <= current) nonces.delete(key);
      if (nonces.has(nonce)) return false;
      if (nonces.size >= maxEntries) throw new PublishWebhookError('WEBHOOK_REPLAY_CAPACITY', 503);
      nonces.set(nonce, expiresAt); return true;
    },
  };
}

export async function readBoundedBody(request, limit = MAX_PUBLISH_WEBHOOK_BODY_BYTES) {
  const reader = request.body?.getReader(); if (!reader) throw new PublishWebhookError('WEBHOOK_BODY_REQUIRED');
  const chunks = []; let size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); throw new PublishWebhookError('WEBHOOK_BODY_TOO_LARGE', 413); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map(part => Buffer.from(part)));
}

export function parsePublishWebhookClaim(body) {
  let value; try { value = JSON.parse(body.toString('utf8')); } catch { throw new PublishWebhookError('WEBHOOK_BODY_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['job', 'snapshot', 'contentHash', 'versionPins', 'immutableContext'].includes(key))) throw new PublishWebhookError('WEBHOOK_BODY_INVALID');
  const job = value.job; const context = value.immutableContext;
  if (!job || typeof job !== 'object' || !uuid.test(job.id ?? '') || typeof job.leaseToken !== 'string' || !Number.isSafeInteger(job.sequence) || !context || typeof context !== 'object' || !uuid.test(context.snapshotID ?? '') || !uuid.test(context.changeSetID ?? '') || !Number.isSafeInteger(context.approvedRevision) || !Array.isArray(context.includedChangeKeys) || context.includedChangeKeys.some(key => typeof key !== 'string') || !uuid.test(context.approvedBy ?? '') || typeof context.approvedAt !== 'string' || !Number.isFinite(Date.parse(context.approvedAt))) throw new PublishWebhookError('WEBHOOK_CLAIM_INVALID');
  return value;
}

/** @param {{url: string, secret: string, claim: any, nonce?: string, timestamp?: number, fetchImpl?: typeof fetch, signal?: AbortSignal}} options */
export function publishWebhookRequest({ url, secret: secretValue, claim, nonce = randomUUID(), timestamp = Date.now(), fetchImpl = fetch, signal }) {
  const body = Buffer.from(JSON.stringify(claim)); const stamp = String(timestamp);
  return fetchImpl(new URL(PUBLISH_WEBHOOK_PATH, url), { method: 'POST', redirect: 'error', signal, headers: { 'content-type': 'application/json', 'x-publish-timestamp': stamp, 'x-publish-nonce': nonce, 'x-publish-signature': signPublishWebhook({ secret: secretValue, timestamp: stamp, nonce, body }), 'content-length': String(body.byteLength) }, body });
}

/** @param {Request} request
 * @param {{secret: string, run: (claim: any, signal?: AbortSignal) => Promise<unknown>, replay?: ReturnType<typeof createReplayGuard>, now?: () => number, maxAgeMs?: number, signal?: AbortSignal}} options */
export async function handlePublishWebhook(request, { secret: secretValue, run, replay = createReplayGuard(), now = () => Date.now(), maxAgeMs = 60_000, signal }) {
  if (request.method !== 'POST' || new URL(request.url).pathname !== PUBLISH_WEBHOOK_PATH) return new Response('Not found.', { status: 404 });
  try {
    const body = await readBoundedBody(request); const timestamp = request.headers.get('x-publish-timestamp'); const nonce = request.headers.get('x-publish-nonce');
    verifyPublishWebhook({ secret: secretValue, timestamp, nonce, signature: request.headers.get('x-publish-signature'), body, now: now(), maxAgeMs });
    if (!replay.use(nonce, Number(timestamp) + maxAgeMs)) throw new PublishWebhookError('WEBHOOK_REPLAY', 409);
    const claim = parsePublishWebhookClaim(body);
    await run(claim, signal);
    return Response.json({ status: 'accepted', buildID: claim.job.id }, { status: 202, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const failure = error instanceof PublishWebhookError ? error : new PublishWebhookError('BUILD_FAILED', 500);
    return Response.json({ error: failure.code }, { status: failure.status, headers: { 'cache-control': 'no-store' } });
  }
}
