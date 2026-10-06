import { createServer } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { neutralFixture } from '@site-engine/contract/fixtures';
import { hash } from '../scripts/run-preview-worker.mjs';
import { dispatchPublishOnce } from '../scripts/run-publish-dispatcher.mjs';
import { createPublishWebhookServer } from '../scripts/run-publish-webhook-receiver.mjs';
import { PUBLISH_WEBHOOK_PATH, createReplayGuard, handlePublishWebhook, publishWebhookRequest } from '../scripts/publish-webhook.mjs';

const secret = 'publish-webhook-test-secret-that-is-at-least-32-bytes';
const pins = { themeVersion: '1.0.0', engineVersion: '1.0.0', contractVersion: '1.0.0' };
const ids = { job: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nonce: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', snapshot: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', set: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', owner: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))); });

function claim() {
  const snapshot = structuredClone(neutralFixture);
  return { job: { id: ids.job, leaseToken: 'lease-token-that-stays-private', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), sequence: 1, correlationID: ids.nonce }, snapshot, contentHash: hash(snapshot), versionPins: pins, immutableContext: { changeSetID: ids.set, approvedRevision: 4, includedChangeKeys: [`pages:${snapshot.pages[0]!.id}`], snapshotID: ids.snapshot, approvedBy: ids.owner, approvedAt: new Date().toISOString() } };
}
async function receiver(run: (value: ReturnType<typeof claim>) => Promise<unknown>) {
  const server = createPublishWebhookServer({ secret, run }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('receiver did not listen');
  return `http://127.0.0.1:${address.port}`;
}
function dispatcherAPI(value: ReturnType<typeof claim>, calls: Array<{ action: string; body: Record<string, unknown> }>) {
  return async (action: string, body: Record<string, unknown> = {}) => { calls.push({ action, body }); if (action === 'claim') return value; return { job: {} }; };
}

describe('signed publish webhook', () => {
  it('dispatches an exact immutable claimed snapshot to a private fake receiver', async () => {
    const received: ReturnType<typeof claim>[] = []; const url = await receiver(async value => { received.push(value); }); const calls: Array<{ action: string; body: Record<string, unknown> }> = []; const value = claim(); const heartbeat = vi.fn();
    await expect(dispatchPublishOnce({ api: dispatcherAPI(value, calls), webhookURL: url, secret, versionPins: pins, heartbeat })).resolves.toBe(true);
    expect(heartbeat).toHaveBeenCalledOnce(); expect(calls.map(call => call.action)).toEqual(['claim', 'log']); expect(received).toEqual([value]);
    await expect(fetch(`${url}/healthz`).then(response => response.json())).resolves.toEqual({ status: 'ok' });
  });

  it('retries through the durable fail API after a receiver failure or timeout', async () => {
    const failed: Array<{ action: string; body: Record<string, unknown> }> = []; const value = claim(); const rejected = await receiver(async () => { throw new Error('synthetic CI failure'); });
    await expect(dispatchPublishOnce({ api: dispatcherAPI(value, failed), webhookURL: rejected, secret, versionPins: pins })).rejects.toThrow('webhook rejected');
    expect(failed.at(-1)).toMatchObject({ action: 'fail', body: { id: ids.job, leaseToken: value.job.leaseToken, errorCode: 'WEBHOOK_FAILED' } });
    const hanging = createServer(() => {}); servers.push(hanging); await new Promise<void>(resolve => hanging.listen(0, '127.0.0.1', resolve)); const address = hanging.address(); if (!address || typeof address === 'string') throw new Error('timeout receiver did not listen');
    const timeoutCalls: Array<{ action: string; body: Record<string, unknown> }> = [];
    await expect(dispatchPublishOnce({ api: dispatcherAPI(claim(), timeoutCalls), webhookURL: `http://127.0.0.1:${address.port}`, secret, versionPins: pins, timeoutMs: 15 })).rejects.toBeDefined();
    expect(timeoutCalls.at(-1)).toMatchObject({ action: 'fail', body: { errorCode: 'BUILD_TIMEOUT' } });
  });

  it('rejects tampered and replayed signed deliveries before invoking the build', async () => {
    const run = vi.fn(async () => {}); const url = await receiver(run); const value = claim();
    const tampered = await fetch(`${url}${PUBLISH_WEBHOOK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-publish-timestamp': String(Date.now()), 'x-publish-nonce': ids.nonce, 'x-publish-signature': 'sha256:' + '0'.repeat(64) }, body: JSON.stringify(value) });
    expect(tampered.status).toBe(401); expect(run).not.toHaveBeenCalled();
    const first = await publishWebhookRequest({ url, secret, claim: value, nonce: ids.nonce }); expect(first.status).toBe(202);
    const replay = await publishWebhookRequest({ url, secret, claim: value, nonce: ids.nonce }); expect(replay.status).toBe(409); expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects expired signatures without consuming replay capacity', async () => {
    const value = claim(); const body = Buffer.from(JSON.stringify(value)); const request = (timestamp: number) => publishWebhookRequest({ url: 'http://internal', secret, claim: value, nonce: ids.nonce, timestamp, fetchImpl: async (input, init) => handlePublishWebhook(new Request(input, init), { secret, run: async () => {}, replay: createReplayGuard(), now: () => Date.now() }) });
    await expect(request(Date.now() - 61_000)).resolves.toMatchObject({ status: 401 });
    expect(body.byteLength).toBeGreaterThan(0);
  });

  it('survives oversized and truncated request bodies', async () => {
    const run = vi.fn(async () => {}); const url = await receiver(run); const oversized = await fetch(`${url}${PUBLISH_WEBHOOK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-publish-timestamp': String(Date.now()), 'x-publish-nonce': ids.nonce, 'x-publish-signature': 'sha256=' + '0'.repeat(64) }, body: 'x'.repeat(1024 * 1024 + 1) });
    expect(oversized.status).toBe(413);
    const address = new URL(url); await new Promise<void>(resolve => { const socket = connect(Number(address.port), address.hostname, () => { socket.end(`POST ${PUBLISH_WEBHOOK_PATH} HTTP/1.1\r\nHost: ${address.host}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`); resolve(); }); socket.on('error', () => resolve()); });
    await new Promise(resolve => setTimeout(resolve, 10)); const valid = await publishWebhookRequest({ url, secret, claim: claim(), nonce: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    expect(valid.status).toBe(202); expect(run).toHaveBeenCalledOnce();
  });
});
