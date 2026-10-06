import { timingSafeEqual } from 'node:crypto'
import { syncMailboxInbound } from './mailbox-inbound-sync'

const noStore = { 'Cache-Control': 'no-store' }
const workerBudgetMS = 35_000

export function mailboxSyncWorkerAuthorized(request: Request): boolean {
  const secret = process.env.MAILBOX_WORKER_TOKEN
  const authorization = request.headers.get('authorization')
  if (!secret || Buffer.byteLength(secret) < 32 || !authorization?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(authorization.slice(7)); const expected = Buffer.from(secret)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

type CycleDependencies = { sync: typeof syncMailboxInbound; budgetMS?: number }
let activeCycle: Promise<{ mailbox: string | null; processed: number }> | undefined

/** One CMS writer owns scheduling; overlapping internal requests share its cycle. */
export function runMailboxSyncCycle(payload: any, dependencies: CycleDependencies = { sync: syncMailboxInbound }, now = Date.now()) {
  if (activeCycle) return activeCycle
  const operation = runCycle(payload, dependencies, now).finally(() => { if (activeCycle === operation) activeCycle = undefined })
  activeCycle = operation
  return operation
}

async function runCycle(payload: any, dependencies: CycleDependencies, now: number) {
  const budget = dependencies.budgetMS ?? workerBudgetMS
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > workerBudgetMS) throw new Error('invalid_worker_budget')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('mailbox_sync_deadline')), budget)
  try {
    const candidates = await payload.find({ collection: 'mailbox-configurations', where: { and: [
      { health: { equals: 'connected' } }, { provider: { in: ['microsoft', 'google'] } },
      { or: [{ inboundNextAttemptAt: { exists: false } }, { inboundNextAttemptAt: { less_than_equal: new Date(now).toISOString() } }] },
    ] }, sort: ['inboundLastSyncedAt', 'id'], limit: 1, depth: 0, overrideAccess: true })
    const mailbox = candidates.docs[0]
    if (!mailbox || controller.signal.aborted) return { mailbox: null, processed: 0 }
    const update = (data: Record<string, unknown>) => payload.update({ collection: 'mailbox-configurations', where: { and: [{ id: { equals: mailbox.id } }, { health: { equals: 'connected' } }, { provider: { equals: mailbox.provider } }] }, data, overrideAccess: true, context: { mailboxInternal: true } })
    try {
      const result = await dependencies.sync(payload, mailbox.id, undefined, controller.signal)
      await update({ inboundLastSyncedAt: new Date(now).toISOString(), inboundNextAttemptAt: new Date(now + 1_000).toISOString(), inboundFailureCount: 0, inboundLastError: null })
      return { mailbox: mailbox.id, processed: result.processed }
    } catch {
      const failures = Math.min(Number(mailbox.inboundFailureCount ?? 0) + 1, 8)
      await update({ inboundFailureCount: failures, inboundLastError: controller.signal.aborted ? 'sync_timeout' : 'sync_failed', inboundNextAttemptAt: new Date(now + Math.min(60_000, 1_000 * 2 ** failures)).toISOString() })
      return { mailbox: mailbox.id, processed: 0 }
    }
  } finally { clearTimeout(timer) }
}

export function createMailboxSyncWorkerRunHandler(dependencies: { payload: () => Promise<any>; run: (payload: any) => Promise<{ mailbox: string | null; processed: number }> }) {
  return async (request: Request): Promise<Response> => {
    if (!mailboxSyncWorkerAuthorized(request)) return Response.json({ error: 'Unauthorized.' }, { status: 401, headers: noStore })
    try {
      const result = await dependencies.run(await dependencies.payload())
      return Response.json(result, { headers: noStore })
    } catch { return Response.json({ error: 'unavailable' }, { status: 503, headers: noStore }) }
  }
}
