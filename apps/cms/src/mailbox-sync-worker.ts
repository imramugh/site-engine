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

/** A separate, one-mailbox bounded cycle. Notification dispatch never calls this. */
export async function runMailboxSyncCycle(payload: any, dependencies = { sync: syncMailboxInbound }, now = Date.now()) {
  const candidates = await payload.find({ collection: 'mailbox-configurations', where: { and: [{ health: { equals: 'connected' } }, { provider: { in: ['microsoft', 'google'] } }] }, sort: 'updatedAt', limit: 25, depth: 0, overrideAccess: true })
  const mailbox = candidates.docs.filter((item: any) => !item.inboundNextAttemptAt || Date.parse(item.inboundNextAttemptAt) <= now).sort((a: any, b: any) => Date.parse(a.inboundLastSyncedAt ?? 0) - Date.parse(b.inboundLastSyncedAt ?? 0))[0]
  if (!mailbox || Date.now() - now >= workerBudgetMS) return { mailbox: null, processed: 0 }
  try {
    const result = await dependencies.sync(payload, mailbox.id)
    await payload.update({ collection: 'mailbox-configurations', id: mailbox.id, data: { inboundLastSyncedAt: new Date(now).toISOString(), inboundNextAttemptAt: new Date(now + 1_000).toISOString(), inboundFailureCount: 0, inboundLastError: null }, overrideAccess: true, context: { mailboxInternal: true } })
    return { mailbox: mailbox.id, processed: result.processed }
  } catch {
    const failures = Math.min(Number(mailbox.inboundFailureCount ?? 0) + 1, 8)
    await payload.update({ collection: 'mailbox-configurations', id: mailbox.id, data: { inboundFailureCount: failures, inboundLastError: 'sync_failed', inboundNextAttemptAt: new Date(now + Math.min(60_000, 1_000 * 2 ** failures)).toISOString() }, overrideAccess: true, context: { mailboxInternal: true } })
    return { mailbox: mailbox.id, processed: 0 }
  }
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
