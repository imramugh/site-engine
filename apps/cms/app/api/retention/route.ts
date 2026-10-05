import { getPayload } from 'payload'
import config from '../../../payload.config'
import { freshStaff, hasRole } from '../../../src/access'
import { serverSessionStrategy } from '../../../src/identity'
import { withPayloadTransaction } from '../../../src/auth-transaction'
import { defaultRetentionPolicy, purgeApplication, purgeRetainedInquiry, retentionPolicy } from '../../../src/retention'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }
const originOK = (request: Request) => { const base = process.env.PAYLOAD_PUBLIC_SERVER_URL; return Boolean(base && request.headers.get('origin') === new URL(base).origin) }

async function actorFor(request: Request) {
  const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  const actor = auth.user as { id?: string; roles?: ('owner' | 'editor' | 'hiring')[]; disabled?: boolean } | null
  return { payload, actor }
}

export async function GET(request: Request) {
  const { payload, actor } = await actorFor(request)
  if (!actor || !hasRole(actor, ['owner'])) return Response.json({ error: 'Owner access required.' }, { status: 403, headers: noStore })
  const [policy, jobs, tombstones] = await Promise.all([
    retentionPolicy(payload), payload.find({ collection: 'retention-purge-jobs', where: { state: { equals: 'failed' } }, sort: '-updatedAt', limit: 50, depth: 0, overrideAccess: true }),
    payload.find({ collection: 'deletion-tombstones', sort: 'createdAt', limit: 0, pagination: false, depth: 0, overrideAccess: true }),
  ])
  return Response.json({ policy, defaults: defaultRetentionPolicy, backupNotice: 'Deleted records are replayed from a minimal deletion ledger before a restored backup serves traffic. Immutable backups age out on their configured schedule.', failedJobs: jobs.docs.map(({ id, resourceType, resourceID, attempts, lastError, updatedAt }) => ({ id, resourceType, resourceID, attempts, lastError, updatedAt })), tombstones: tombstones.docs.map(({ resourceType, resourceID, deletedAt }) => ({ resourceType, resourceID, deletedAt })) }, { headers: noStore })
}

export async function PUT(request: Request) {
  if (!originOK(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  const { payload, actor } = await actorFor(request)
  if (!actor?.id || !(await freshStaff(['owner'])({ req: { payload, user: actor, headers: request.headers } as never }))) return Response.json({ error: 'Fresh Owner authentication is required.' }, { status: 403, headers: noStore })
  let body: { spamDays?: unknown; mediaBinDays?: unknown }
  try { body = await request.json() } catch { return Response.json({ error: 'Send a valid policy.' }, { status: 400, headers: noStore }) }
  const valid = (value: unknown) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 365
  if (!valid(body.spamDays) || !valid(body.mediaBinDays) || Object.keys(body).some(key => !['spamDays', 'mediaBinDays'].includes(key))) return Response.json({ error: 'Retention periods must be whole days between 1 and 365.' }, { status: 422, headers: noStore })
  const saved = await withPayloadTransaction(payload, async req => {
    const current = await payload.find({ collection: 'retention-settings', limit: 1, depth: 0, overrideAccess: true, req })
  const data = { key: 'default', spamDays: Number(body.spamDays), mediaBinDays: Number(body.mediaBinDays) }
  const saved = current.docs[0] ? await payload.update({ collection: 'retention-settings', id: current.docs[0].id, data, overrideAccess: true, req }) : await payload.create({ collection: 'retention-settings', data, overrideAccess: true, req })
  await payload.create({ collection: 'audit-events', data: { event: 'retention.policy_changed', user: actor.id, actor: actor.id, detail: { spamDays: data.spamDays, mediaBinDays: data.mediaBinDays } }, overrideAccess: true, req })
    return saved
  })
  return Response.json({ policy: { ...defaultRetentionPolicy, spamDays: saved.spamDays, mediaBinDays: saved.mediaBinDays } }, { headers: noStore })
}

export async function DELETE(request: Request) {
  if (!originOK(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  const { payload, actor } = await actorFor(request)
  if (!actor?.id || !(await freshStaff(['owner'])({ req: { payload, user: actor, headers: request.headers } as never }))) return Response.json({ error: 'Fresh Owner authentication is required.' }, { status: 403, headers: noStore })
  let body: { applicationID?: unknown; inquiryID?: unknown; confirm?: unknown }; try { body = await request.json() } catch { return Response.json({ error: 'Send a valid deletion request.' }, { status: 400, headers: noStore }) }
  const id = typeof body.applicationID === 'string' ? body.applicationID : typeof body.inquiryID === 'string' ? body.inquiryID : undefined
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || body.confirm !== 'permanent-delete' || Boolean(body.applicationID) === Boolean(body.inquiryID)) return Response.json({ error: 'Choose one record and confirm permanent deletion.' }, { status: 422, headers: noStore })
  if (body.inquiryID) { await purgeRetainedInquiry(payload, id, actor.id); return Response.json({ state: 'completed' }, { headers: noStore }) }
  const result = await purgeApplication(payload, id, actor.id)
  return Response.json(result, { status: result.state === 'completed' ? 200 : 503, headers: noStore })
}
