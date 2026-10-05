import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { hasRole } from '../../../../src/access'
import { canTransitionLead, LeadAssigneeError, leadStages, validateLeadAssignee, type LeadStage } from '../../../../src/inquiries'
import { serverSessionStrategy } from '../../../../src/identity'
import { withPayloadTransaction } from '../../../../src/auth-transaction'

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
  return value as { stage?: unknown; notes?: unknown; nextAction?: unknown; assignee?: unknown }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  const actor = authenticated.user as { id: string; roles?: ('owner' | 'sales')[] } | null
  if (!hasRole(actor as never, ['owner', 'sales'])) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
  const { id } = await context.params
  let body: { stage?: unknown; notes?: unknown; nextAction?: unknown; assignee?: unknown }
  try { body = await boundedJSON(request) } catch (error) { const tooLarge = error instanceof Error && error.message === 'TOO_LARGE'; return Response.json({ error: tooLarge ? 'The lead update is too large.' : 'Send a valid update.' }, { status: tooLarge ? 413 : 400, headers: noStore }) }
  try {
    const lead = await withPayloadTransaction(payload, async (req) => {
      const current = await payload.findByID({ collection: 'inquiries', id, depth: 0, overrideAccess: true, req })
      const next = body.stage === undefined ? current.stage as LeadStage : body.stage as LeadStage
      if (!leadStages.includes(next) || !canTransitionLead((current.stage ?? 'new') as LeadStage, next)) throw new Error('INVALID_TRANSITION')
      const data: Record<string, unknown> = { stage: next }
      for (const field of ['notes', 'nextAction'] as const) if (body[field] !== undefined) {
        if (typeof body[field] !== 'string' || body[field].length > 5_000) throw new Error(`INVALID_${field.toUpperCase()}`)
        data[field] = body[field]
      }
      if (body.assignee !== undefined) data.assignee = await validateLeadAssignee(payload, body.assignee)
      const updated = await payload.update({ collection: 'inquiries', id, data, overrideAccess: true, req, user: actor as never })
      await payload.create({ collection: 'audit-events', data: { event: 'lead.updated', user: actor!.id, actor: actor!.id, detail: { lead: id, fields: Object.keys(data) } }, overrideAccess: true, req })
      return updated
    })
    return Response.json({ lead: { id: lead.id, stage: lead.stage, notes: lead.notes ?? '', nextAction: lead.nextAction ?? '', assignee: typeof lead.assignee === 'string' ? lead.assignee : lead.assignee?.id ?? null, updatedAt: lead.updatedAt } }, { headers: noStore })
  } catch (error) {
    if (error instanceof LeadAssigneeError) return Response.json({ error: error.message }, { status: 422, headers: noStore })
    if (error instanceof Error && error.message === 'INVALID_TRANSITION') return Response.json({ error: 'That lead-stage transition is not allowed.' }, { status: 422, headers: noStore })
    if (error instanceof Error && error.message.startsWith('INVALID_')) return Response.json({ error: `Invalid ${error.message.slice(8).toLowerCase()}.` }, { status: 422, headers: noStore })
    if (error && typeof error === 'object' && 'status' in error && error.status === 404) return Response.json({ error: 'Lead not found.' }, { status: 404, headers: noStore })
    return Response.json({ error: 'Lead could not be updated.' }, { status: 422, headers: noStore })
  }
}
