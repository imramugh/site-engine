import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'

export class MailboxWorkerError extends Error { constructor(code) { super(code); this.code = code } }
export function normalizeCMSOrigin(value) {
  if (typeof value !== 'string' || value.length > 2_048 || /[\r\n]/.test(value)) throw new MailboxWorkerError('INVALID_WORKER_CONFIGURATION')
  let url; try { url = new URL(value) } catch { throw new MailboxWorkerError('INVALID_WORKER_CONFIGURATION') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new MailboxWorkerError('INVALID_WORKER_CONFIGURATION')
  return url.origin
}
export function createMailboxWorkerAPI({ cmsOrigin, token, fetchImpl = fetch, timeoutMs = 45_000 }) {
  const origin = normalizeCMSOrigin(cmsOrigin)
  if (typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 55_000) throw new MailboxWorkerError('INVALID_WORKER_CONFIGURATION')
  return async signal => {
    const timeout = AbortSignal.timeout(timeoutMs)
    const response = await fetchImpl(`${origin}/api/internal/mailbox-worker/run`, { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { authorization: `Bearer ${token}` } })
    if (!response.ok) { await response.body?.cancel(); throw new MailboxWorkerError(response.status === 401 ? 'WORKER_UNAUTHORIZED' : 'CMS_UNAVAILABLE') }
    let body; try { body = await response.json() } catch { throw new MailboxWorkerError('INVALID_CMS_RESPONSE') }
    if (body?.mailbox === null) return null
    if (typeof body?.mailbox?.id !== 'string' || typeof body?.mailbox?.state !== 'string' || Object.keys(body.mailbox).some(key => key !== 'id' && key !== 'state')) throw new MailboxWorkerError('INVALID_CMS_RESPONSE')
    return body.mailbox
  }
}
const pause = (milliseconds, signal) => signal?.aborted ? Promise.resolve() : new Promise(resolve => { const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }; const timer = setTimeout(done, milliseconds); signal?.addEventListener('abort', done, { once: true }) })
/** Sequential HTTP-only poller; it deliberately has no SQLite or SMTP access. */
/** @param {{ api: (signal?: AbortSignal) => Promise<unknown>; signal?: AbortSignal; idleMs?: number; errorMs?: number; log?: (message: string) => void; heartbeat?: () => Promise<void> }} input */
export async function runMailboxWorker({ api, signal, idleMs = 2_000, errorMs = 5_000, log = console.error, heartbeat = async () => {} }) {
  if (![idleMs, errorMs].every(value => Number.isSafeInteger(value) && value >= 100 && value <= 60_000)) throw new MailboxWorkerError('INVALID_WORKER_CONFIGURATION')
  while (!signal?.aborted) { try { await api(signal); await heartbeat(); await pause(idleMs, signal) } catch (error) { if (!signal?.aborted) log(`Mailbox worker: ${error?.code ?? 'WORKER_FAILED'}`); await pause(errorMs, signal) } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController(); for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => controller.abort())
  const api = createMailboxWorkerAPI({ cmsOrigin: process.env.MAILBOX_WORKER_CMS_ORIGIN, token: process.env.MAILBOX_WORKER_TOKEN, timeoutMs: Number(process.env.MAILBOX_WORKER_TIMEOUT_MS ?? 45_000) })
  const heartbeatFile = process.env.MAILBOX_WORKER_HEARTBEAT_FILE ?? '/tmp/mailbox-worker-heartbeat'
  await runMailboxWorker({ api, signal: controller.signal, idleMs: Number(process.env.MAILBOX_WORKER_IDLE_MS ?? 2_000), errorMs: Number(process.env.MAILBOX_WORKER_ERROR_MS ?? 5_000), heartbeat: () => writeFile(heartbeatFile, `${Date.now()}\n`, { mode: 0o600 }) })
}
