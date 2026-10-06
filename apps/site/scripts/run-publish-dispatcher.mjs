import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { createPublishAPI, validatePublishClaim } from './run-publish-worker.mjs';
import { publishWebhookRequest } from './publish-webhook.mjs';

/** @param {{api: (action: string, body?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>, webhookURL: string, secret: string, versionPins: Record<string, string>, timeoutMs?: number, fetchImpl?: typeof fetch, signal?: AbortSignal, heartbeat?: () => Promise<void>}} options */
export async function dispatchPublishOnce({ api, webhookURL, secret, versionPins, timeoutMs = 120_000, fetchImpl = fetch, signal, heartbeat = async () => {} }) {
  const raw = await api('claim', {}, signal); await heartbeat(); const claim = validatePublishClaim(raw, versionPins); if (!claim) return false;
  await api('log', { id: claim.job.id, leaseToken: claim.job.leaseToken, stage: 'dispatched' }, signal);
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await publishWebhookRequest({ url: webhookURL, secret, claim: raw, fetchImpl, signal: combined });
    if (!response.ok) throw Object.assign(new Error('webhook rejected'), { code: response.status === 409 ? 'WEBHOOK_REPLAY' : 'WEBHOOK_FAILED' });
    return true;
  } catch (error) {
    try { await api('fail', { id: claim.job.id, leaseToken: claim.job.leaseToken, errorCode: controller.signal.aborted ? 'BUILD_TIMEOUT' : error?.code ?? 'WEBHOOK_FAILED' }, signal); } catch { /* The receiver may have recorded the terminal lease result first. */ }
    throw error;
  } finally { clearTimeout(timeout); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController(); for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => controller.abort());
  const versionPins = { engineVersion: process.env.SITE_ENGINE_VERSION, contractVersion: process.env.SITE_CONTRACT_VERSION };
  if (!process.env.PUBLISH_BUILD_WEBHOOK_URL || !process.env.PUBLISH_WEBHOOK_SECRET || Object.values(versionPins).some(value => !value)) throw new Error('INVALID_DISPATCHER_CONFIGURATION');
  const api = createPublishAPI({ cmsOrigin: process.env.PUBLISH_CMS_ORIGIN, token: process.env.PUBLISH_WORKER_TOKEN });
  const heartbeat = async () => { if (process.env.PUBLISH_DISPATCHER_HEALTH_FILE) await writeFile(process.env.PUBLISH_DISPATCHER_HEALTH_FILE, `${new Date().toISOString()}\n`, { mode: 0o600 }); };
  while (!controller.signal.aborted) { try { await dispatchPublishOnce({ api, webhookURL: process.env.PUBLISH_BUILD_WEBHOOK_URL, secret: process.env.PUBLISH_WEBHOOK_SECRET, versionPins, timeoutMs: Number(process.env.PUBLISH_DISPATCH_TIMEOUT_MS || 120_000), signal: controller.signal, heartbeat }); } catch (error) { console.error(`Publish dispatcher: ${error.code ?? 'DISPATCH_FAILED'}`); } await new Promise(done => setTimeout(done, 2_000)); }
}
