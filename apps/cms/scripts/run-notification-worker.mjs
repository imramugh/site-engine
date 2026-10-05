import { pathToFileURL } from 'node:url'

export class NotificationWorkerError extends Error { constructor(code) { super(code); this.code = code } }
export function normalizeCMSOrigin(value) {
  if (typeof value !== 'string' || value.length > 2_048 || /[\r\n]/.test(value)) throw new NotificationWorkerError('INVALID_WORKER_CONFIGURATION')
  let url; try { url = new URL(value) } catch { throw new NotificationWorkerError('INVALID_WORKER_CONFIGURATION') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new NotificationWorkerError('INVALID_WORKER_CONFIGURATION')
  return url.origin
}
export function createNotificationWorkerAPI({ cmsOrigin, token, fetchImpl = fetch, timeoutMs = 45_000 }) {
  const origin = normalizeCMSOrigin(cmsOrigin)
  if (typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 55_000) throw new NotificationWorkerError('INVALID_WORKER_CONFIGURATION')
  return async signal => {
    const timeout = AbortSignal.timeout(timeoutMs)
    const response = await fetchImpl(`${origin}/api/internal/notification-worker/run`, { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { authorization: `Bearer ${token}` } })
    if (!response.ok) { await response.body?.cancel(); throw new NotificationWorkerError(response.status === 401 ? 'WORKER_UNAUTHORIZED' : 'CMS_UNAVAILABLE') }
    let body; try { body = await response.json() } catch { throw new NotificationWorkerError('INVALID_CMS_RESPONSE') }
    if (body?.delivery === null) return null
    if (typeof body?.delivery?.id !== 'string' || typeof body?.delivery?.state !== 'string' || Object.keys(body.delivery).some(key => key !== 'id' && key !== 'state')) throw new NotificationWorkerError('INVALID_CMS_RESPONSE')
    return body.delivery
  }
}
const pause = (milliseconds, signal) => signal?.aborted ? Promise.resolve() : new Promise(resolve => { const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }; const timer = setTimeout(done, milliseconds); signal?.addEventListener('abort', done, { once: true }) })
/** Sequential HTTP-only poller; it deliberately has no SQLite or SMTP access. */
export async function runNotificationWorker({ api, signal, idleMs = 2_000, errorMs = 5_000, log = console.error }) {
  if (![idleMs, errorMs].every(value => Number.isSafeInteger(value) && value >= 100 && value <= 60_000)) throw new NotificationWorkerError('INVALID_WORKER_CONFIGURATION')
  while (!signal?.aborted) { try { await api(signal); await pause(idleMs, signal) } catch (error) { if (!signal?.aborted) log(`Notification worker: ${error?.code ?? 'WORKER_FAILED'}`); await pause(errorMs, signal) } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController(); for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => controller.abort())
  const api = createNotificationWorkerAPI({ cmsOrigin: process.env.NOTIFICATION_WORKER_CMS_ORIGIN, token: process.env.NOTIFICATION_WORKER_TOKEN, timeoutMs: Number(process.env.NOTIFICATION_WORKER_TIMEOUT_MS ?? 45_000) })
  await runNotificationWorker({ api, signal: controller.signal, idleMs: Number(process.env.NOTIFICATION_WORKER_IDLE_MS ?? 2_000), errorMs: Number(process.env.NOTIFICATION_WORKER_ERROR_MS ?? 5_000) })
}
