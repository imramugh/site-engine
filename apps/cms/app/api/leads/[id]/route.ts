import { sqliteAuthenticationBoundary } from '../../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { freshStaff, hasRole } from '../../../../src/access'
import { canTransitionLead, LeadAssigneeError, leadStages, validateLeadAssignee, type LeadStage } from '../../../../src/inquiries'
import { serverSessionStrategy } from '../../../../src/identity'
import { withPayloadTransaction } from '../../../../src/auth-transaction'
import { classifyLeadAsSpam, deleteSpamLead, LeadSpamLifecycleError, restoreLeadFromSpam } from '../../../../src/lead-spam-lifecycle'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../../src/sqlite'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }
const maxBodyBytes = 16_384
function sameOrigin(request: Request) { const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; return Boolean(configured && request.headers.get('origin') === new URL(configured).origin) }

async function boundedJSON(request: Request) {
  const reader = request.body?.getReader(); if (!reader) throw new Error('INVALID')
  const chunks: Uint8Array[] = []; let size = 0
  while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maxBodyBytes) { await reader.cancel(); throw new Error('TOO_LARGE') }; chunks.push(next.value) }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID')
  return value as { action?: unknown; stage?: unknown; notes?: unknown; nextAction?: unknown; nextActionDueAt?: unknown; assignee?: unknown }
}

async function PATCHHandler(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  const actor = authenticated.user as { id: string; roles?: ('owner' | 'sales')[] } | null
  if (!hasRole(actor as never, ['owner', 'sales'])) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
  const { id } = await context.params
  let body: { action?: unknown; stage?: unknown; notes?: unknown; nextAction?: unknown; nextActionDueAt?: unknown; assignee?: unknown }
  try { body = await boundedJSON(request) } catch (error) { const tooLarge = error instanceof Error && error.message === 'TOO_LARGE'; return Response.json({ error: tooLarge ? 'The lead update is too large.' : 'Send a valid update.' }, { status: tooLarge ? 413 : 400, headers: noStore }) }
  try {
    if (body.action !== undefined) {
      if ((body.action !== 'mark-spam' && body.action !== 'not-spam') || Object.keys(body).some((field) => field !== 'action')) return Response.json({ error: 'Send one valid spam action.' }, { status: 422, headers: noStore })
      const lead = body.action === 'mark-spam' ? await classifyLeadAsSpam(payload, id, actor!.id) : await restoreLeadFromSpam(payload, id, actor!.id)
      return Response.json({ lead: { id: lead.id, stage: lead.stage, spam: Boolean(lead.spam), updatedAt: lead.updatedAt } }, { headers: noStore })
    }
    if (Object.keys(body).some((field) => !['stage', 'notes', 'nextAction', 'nextActionDueAt', 'assignee'].includes(field))) return Response.json({ error: 'Send only supported lead fields.' }, { status: 422, headers: noStore })
    const lead = await withPayloadTransaction(payload, async (req) => {
      const current = await payload.findByID({ collection: 'inquiries', id, depth: 0, overrideAccess: true, req })
      if (current.spam) throw new Error('SPAM_RECORD')
      const next = body.stage === undefined ? current.stage as LeadStage : body.stage as LeadStage
      if (!leadStages.includes(next) || !canTransitionLead((current.stage ?? 'new') as LeadStage, next)) throw new Error('INVALID_TRANSITION')
      const data: Record<string, unknown> = { stage: next }
      for (const field of ['notes', 'nextAction'] as const) if (body[field] !== undefined) {
        if (typeof body[field] !== 'string' || body[field].length > 5_000) throw new Error(`INVALID_${field.toUpperCase()}`)
        data[field] = body[field]
      }
      if (body.nextActionDueAt !== undefined) {
        if (body.nextActionDueAt !== null && (typeof body.nextActionDueAt !== 'string' || Number.isNaN(new Date(body.nextActionDueAt).valueOf()))) throw new Error('INVALID_NEXT_ACTION_DUE_AT')
        data.nextActionDueAt = body.nextActionDueAt
      }
      if (body.assignee !== undefined) data.assignee = await validateLeadAssignee(payload, body.assignee)
      const updated = await payload.update({ collection: 'inquiries', id, data, overrideAccess: true, req, user: actor as never })
      await payload.create({ collection: 'audit-events', data: { event: 'lead.updated', user: actor!.id, actor: actor!.id, detail: { lead: id, fields: Object.keys(data) } }, overrideAccess: true, req })
      return updated
    })
    return Response.json({ lead: { id: lead.id, stage: lead.stage, notes: lead.notes ?? '', nextAction: lead.nextAction ?? '', nextActionDueAt: lead.nextActionDueAt ?? null, assignee: typeof lead.assignee === 'string' ? lead.assignee : lead.assignee?.id ?? null, updatedAt: lead.updatedAt } }, { headers: noStore })
  } catch (error) {
    const backpressure = sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, noStore)
    if (backpressure) return backpressure
    if (error instanceof LeadSpamLifecycleError) return Response.json({ error: error.message }, { status: error.code === 'NOT_FOUND' ? 404 : 409, headers: noStore })
    if (error instanceof LeadAssigneeError) return Response.json({ error: error.message }, { status: 422, headers: noStore })
    if (error instanceof Error && error.message === 'INVALID_TRANSITION') return Response.json({ error: 'That lead-stage transition is not allowed.' }, { status: 422, headers: noStore })
    if (error instanceof Error && error.message === 'SPAM_RECORD') return Response.json({ error: 'Restore spam before editing lead details.' }, { status: 409, headers: noStore })
    if (error instanceof Error && error.message.startsWith('INVALID_')) return Response.json({ error: `Invalid ${error.message.slice(8).toLowerCase()}.` }, { status: 422, headers: noStore })
    if (error && typeof error === 'object' && 'status' in error && error.status === 404) return Response.json({ error: 'Lead not found.' }, { status: 404, headers: noStore })
    return Response.json({ error: 'Lead could not be updated.' }, { status: 422, headers: noStore })
  }
}

async function DELETEHandler(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  const actor = authenticated.user as { id: string; roles?: ('owner' | 'sales')[] } | null
  if (!actor?.id || !(await freshStaff(['owner'])({ req: { payload, user: actor, headers: request.headers } as never }))) return Response.json({ error: 'Fresh Owner authentication is required.' }, { status: 403, headers: noStore })
  try {
    const { id } = await context.params
    await deleteSpamLead(payload, id, actor.id)
    return new Response(null, { status: 204, headers: noStore })
  } catch (error) {
    const backpressure = sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, noStore)
    if (backpressure) return backpressure
    if (error instanceof LeadSpamLifecycleError) return Response.json({ error: error.message }, { status: error.code === 'NOT_FOUND' ? 404 : error.code === 'ACTIVE_SEND' ? 409 : 422, headers: noStore })
    return Response.json({ error: 'Spam record could not be deleted.' }, { status: 422, headers: noStore })
  }
}

export const PATCH = sqliteAuthenticationBoundary(PATCHHandler)
export const DELETE = sqliteAuthenticationBoundary(DELETEHandler)
