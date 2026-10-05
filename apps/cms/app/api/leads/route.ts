import { getPayload, type Payload } from 'payload'
import config from '../../../payload.config'
import { hasRole } from '../../../src/access'
import { createAcceptedInquiry, leadStages, manualInquiryInput } from '../../../src/inquiries'
import { serverSessionStrategy } from '../../../src/identity'
import { LeadFilterError, leadWhere, parseLeadFilters, type LeadFilters } from '../../../src/lead-filters'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }
const maxBodyBytes = 16_384

async function staff(request: Request) {
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  const user = authenticated.user as { id: string; roles?: ('owner' | 'sales')[]; disabled?: boolean } | null
  return { payload, user: user && hasRole(user, ['owner', 'sales']) ? user : null }
}

function sameOrigin(request: Request) {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  return Boolean(configured && request.headers.get('origin') === new URL(configured).origin)
}

async function boundedJSON(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('INVALID')
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > maxBodyBytes) { await reader.cancel(); throw new Error('TOO_LARGE') }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID')
  return parsed as Record<string, unknown>
}

function view(inquiry: Record<string, unknown>) {
  const assignee = inquiry.assignee
  return {
    id: String(inquiry.id), email: String(inquiry.email ?? ''),
    name: typeof inquiry.name === 'string' ? inquiry.name : undefined,
    telephone: typeof inquiry.telephone === 'string' ? inquiry.telephone : undefined,
    company: typeof inquiry.company === 'string' ? inquiry.company : undefined,
    topic: String(inquiry.topic ?? ''), message: String(inquiry.message ?? ''),
    stage: String(inquiry.stage ?? 'new'), urgent: inquiry.urgent === true,
    sourcePage: String(inquiry.sourcePage ?? ''),
    notes: typeof inquiry.notes === 'string' ? inquiry.notes : undefined,
    nextAction: typeof inquiry.nextAction === 'string' ? inquiry.nextAction : undefined,
    assignee: typeof assignee === 'string' ? assignee : assignee && typeof assignee === 'object' && 'id' in assignee ? String(assignee.id) : null,
    consentBasis: typeof inquiry.consentBasis === 'string' ? inquiry.consentBasis : undefined,
    consentedAt: typeof inquiry.consentedAt === 'string' ? inquiry.consentedAt : undefined,
    createdAt: typeof inquiry.createdAt === 'string' ? inquiry.createdAt : undefined,
    updatedAt: typeof inquiry.updatedAt === 'string' ? inquiry.updatedAt : undefined,
  }
}

async function pipelineFor(payload: Payload, filters: LeadFilters) {
  const entries = await Promise.all(leadStages.map(async (stage) => {
    const common = leadWhere(filters, false)
    const clauses = common ? [...(common as { and: Record<string, unknown>[] }).and, { stage: { equals: stage } }] : [{ stage: { equals: stage } }]
    const result = await payload.find({ collection: 'inquiries', where: { and: clauses } as never, sort: '-urgent,-updatedAt', limit: 6, page: 1, depth: 0, overrideAccess: true })
    return [stage, { leads: result.docs.map((lead) => view(lead as unknown as Record<string, unknown>)), totalDocs: result.totalDocs, hasMore: result.hasNextPage }] as const
  }))
  return Object.fromEntries(entries)
}

export async function GET(request: Request): Promise<Response> {
  const { payload, user } = await staff(request)
  if (!user) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
  const url = new URL(request.url)
  let filters: LeadFilters
  try { filters = parseLeadFilters(url) } catch (error) {
    if (error instanceof LeadFilterError) return Response.json({ error: error.message }, { status: 400, headers: noStore })
    throw error
  }
  const [result, users, pipeline, sources, spamCount] = await Promise.all([
    payload.find({ collection: 'inquiries', where: leadWhere(filters, true), sort: '-urgent,-updatedAt', limit: 50, page: filters.page, depth: 0, overrideAccess: true }),
    payload.find({ collection: 'users', where: { disabled: { not_equals: true } }, limit: 200, depth: 0, overrideAccess: true }),
    filters.spam ? Promise.resolve(Object.fromEntries(leadStages.map((stage) => [stage, { leads: [], totalDocs: 0, hasMore: false }]))) : pipelineFor(payload, filters),
    payload.find({ collection: 'inquiries', where: { or: [{ spam: { equals: false } }, { spam: { exists: false } }] }, limit: 0, pagination: false, depth: 0, select: { sourcePage: true }, overrideAccess: true }),
    payload.count({ collection: 'inquiries', where: { spam: { equals: true } }, overrideAccess: true }),
  ])
  const assignees = users.docs.filter((candidate) => hasRole(candidate as never, ['owner', 'sales'])).map((candidate) => ({ id: candidate.id, name: candidate.name || candidate.email, email: candidate.email }))
  const sourcePages = [...new Set(sources.docs.map((lead) => lead.sourcePage).filter((source): source is string => typeof source === 'string'))].sort()
  return Response.json({ leads: result.docs.map((lead) => view(lead as unknown as Record<string, unknown>)), pipeline, assignees, sourcePages, spamTotalDocs: spamCount.totalDocs, canDeleteSpam: hasRole(user, ['owner']), page: result.page, totalPages: result.totalPages, totalDocs: result.totalDocs, hasNextPage: result.hasNextPage, hasPrevPage: result.hasPrevPage }, { headers: noStore })
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  const { payload, user } = await staff(request)
  if (!user) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
  let body: Record<string, unknown>
  try { body = await boundedJSON(request) } catch (error) {
    const status = error instanceof Error && error.message === 'TOO_LARGE' ? 413 : 400
    return Response.json({ errors: { form: status === 413 ? 'The lead is too large.' : 'Send a valid lead.' } }, { status, headers: noStore })
  }
  const { input, errors } = manualInquiryInput(body)
  if (!input) return Response.json({ errors }, { status: 422, headers: noStore })
  const result = await createAcceptedInquiry(payload, input, user)
  if ('suppressed' in result) return Response.json({ error: 'Manual leads cannot use spam fields.' }, { status: 400, headers: noStore })
  return Response.json({ lead: view(result.inquiry as unknown as Record<string, unknown>) }, { status: 201, headers: noStore })
}
