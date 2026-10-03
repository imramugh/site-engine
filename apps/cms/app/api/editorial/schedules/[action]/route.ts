import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { withPayloadTransaction } from '../../../../../src/auth-transaction'
import { serverSessionStrategy } from '../../../../../src/identity'
import { cancelScheduledPublication, reschedulePublication } from '../../../../../src/publishing'
import { hasRole } from '../../../../../src/access'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }

function sameOrigin(request: Request): boolean {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  return Boolean(configured && origin && origin === new URL(configured).origin)
}

export async function POST(request: Request, context: { params: Promise<{ action: string }> }): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  try {
    const body = await request.json() as { id?: unknown; scheduledFor?: unknown }
    if (typeof body.id !== 'string') throw new Error('A scheduled publication ID is required.')
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    if (!authenticated.user) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
    const { action } = await context.params
    const result = await withPayloadTransaction(payload, async req => {
      req.user = authenticated.user; req.headers = request.headers
      if (action === 'cancel') return cancelScheduledPublication({ payload, req, actor: authenticated.user as never, id: body.id as string })
      if (action === 'reschedule') return reschedulePublication({ payload, req, actor: authenticated.user as never, id: body.id as string, scheduledFor: body.scheduledFor })
      throw new Error('Unknown scheduled publication action.')
    })
    return Response.json(result, { headers: noStore })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Scheduled publication request failed.'
    return Response.json({ error: message }, { status: /Owner role|required|Fresh authentication/i.test(message) ? 403 : 400, headers: noStore })
  }
}

export async function GET(request: Request, context: { params: Promise<{ action: string }> }): Promise<Response> {
  const { action } = await context.params
  if (action !== 'list') return Response.json({ error: 'Unknown scheduled publication action.' }, { status: 404, headers: noStore })
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  if (!authenticated.user) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
  if (!hasRole(authenticated.user as never, ['owner', 'approver'])) return Response.json({ error: 'Reviewer role required.' }, { status: 403, headers: noStore })
  const schedules = await payload.find({ collection: 'scheduled-publications', sort: 'scheduledFor', depth: 1, limit: 25, overrideAccess: true })
  return Response.json({
    schedules: schedules.docs.map((schedule) => ({
      id: schedule.id,
      changeSet: schedule.changeSet,
      scheduledFor: schedule.scheduledFor,
      state: schedule.state,
      dispatchReason: schedule.dispatchReason,
      snapshot: schedule.snapshot && typeof schedule.snapshot === 'object' ? { contentHash: (schedule.snapshot as { contentHash?: unknown }).contentHash } : undefined,
    })),
    page: schedules.page,
    totalPages: schedules.totalPages,
    totalDocs: schedules.totalDocs,
  }, { headers: noStore })
}
