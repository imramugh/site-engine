import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { hasRole } from '../../../../src/access'
import { canTransitionLead, LeadAssigneeError, leadStages, validateLeadAssignee, type LeadStage } from '../../../../src/inquiries'
import { serverSessionStrategy } from '../../../../src/identity'

export const dynamic = 'force-dynamic'
function sameOrigin(request: Request) { const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; return Boolean(configured && request.headers.get('origin') === new URL(configured).origin) }

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403 })
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  if (!hasRole(authenticated.user as never, ['owner', 'sales'])) return Response.json({ error: 'Authentication required.' }, { status: 401 })
  const { id } = await context.params
  let body: { stage?: unknown; notes?: unknown; nextAction?: unknown; assignee?: unknown }
  try { body = await request.json() } catch { return Response.json({ error: 'Send a valid update.' }, { status: 400 }) }
  let current
  try { current = await payload.findByID({ collection: 'inquiries', id, depth: 0, overrideAccess: true }) } catch { return Response.json({ error: 'Lead not found.' }, { status: 404 }) }
  try {
    const next = body.stage === undefined ? current.stage as LeadStage : body.stage as LeadStage
    if (!leadStages.includes(next) || !canTransitionLead((current.stage ?? 'new') as LeadStage, next)) return Response.json({ error: 'That lead-stage transition is not allowed.' }, { status: 422 })
    const data: Record<string, unknown> = { stage: next }
    for (const field of ['notes', 'nextAction'] as const) if (body[field] !== undefined) {
      if (typeof body[field] !== 'string' || body[field].length > 5_000) return Response.json({ error: `Invalid ${field}.` }, { status: 422 })
      data[field] = body[field]
    }
    if (body.assignee !== undefined) data.assignee = await validateLeadAssignee(payload, body.assignee)
    const lead = await payload.update({ collection: 'inquiries', id, data, overrideAccess: true })
    return Response.json({ lead })
  } catch (error) {
    if (error instanceof LeadAssigneeError) return Response.json({ error: error.message }, { status: 422 })
    return Response.json({ error: 'Lead could not be updated.' }, { status: 422 })
  }
}
