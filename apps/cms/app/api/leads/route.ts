import { getPayload, type Payload } from 'payload'
import config from '../../../payload.config'
import { hasRole } from '../../../src/access'
import { createAcceptedInquiry, leadStages, manualInquiryInput } from '../../../src/inquiries'
import { serverSessionStrategy } from '../../../src/identity'

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

function filterClauses(url: URL, includeStage: boolean) {
  const stage = url.searchParams.get('stage')
  const urgent = url.searchParams.get('urgent')
  const assignee = url.searchParams.get('assignee')
  const clauses: Record<string, unknown>[] = []
  if (includeStage && stage && leadStages.includes(stage as never)) clauses.push({ stage: { equals: stage } })
  if (urgent === 'true') clauses.push({ urgent: { equals: true } })
  if (assignee) clauses.push({ assignee: { equals: assignee } })
  return clauses
}

function where(clauses: Record<string, unknown>[]) { return clauses.length ? { and: clauses } as never : undefined }
function pageOf(value: string | null) { const parsed = Number(value ?? '1'); return Number.isInteger(parsed) && parsed > 0 ? parsed : 1 }

async function pipelineFor(payload: Payload, url: URL) {
  const common = filterClauses(url, false)
  const entries = await Promise.all(leadStages.map(async (stage) => {
    const result = await payload.find({ collection: 'inquiries', where: where([...common, { stage: { equals: stage } }]), sort: '-urgent,-updatedAt', limit: 6, page: 1, depth: 0, overrideAccess: true })
    return [stage, { leads: result.docs.map((lead) => view(lead as unknown as Record<string, unknown>)), totalDocs: result.totalDocs, hasMore: result.hasNextPage }] as const
  }))
  return Object.fromEntries(entries)
}

export async function GET(request: Request): Promise<Response> {
  const { payload, user } = await staff(request)
  if (!user) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
  const url = new URL(request.url)
  const page = pageOf(url.searchParams.get('page'))
  const [result, users, pipeline] = await Promise.all([
    payload.find({ collection: 'inquiries', where: where(filterClauses(url, true)), sort: '-urgent,-updatedAt', limit: 50, page, depth: 0, overrideAccess: true }),
    payload.find({ collection: 'users', where: { disabled: { not_equals: true } }, limit: 200, depth: 0, overrideAccess: true }),
    pipelineFor(payload, url),
  ])
  const assignees = users.docs.filter((candidate) => hasRole(candidate as never, ['owner', 'sales'])).map((candidate) => ({ id: candidate.id, name: candidate.name || candidate.email, email: candidate.email }))
  return Response.json({ leads: result.docs.map((lead) => view(lead as unknown as Record<string, unknown>)), pipeline, assignees, page: result.page, totalPages: result.totalPages, totalDocs: result.totalDocs, hasNextPage: result.hasNextPage, hasPrevPage: result.hasPrevPage }, { headers: noStore })
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
  const result = await createAcceptedInquiry(payload, input)
  if ('suppressed' in result) return Response.json({ error: 'Manual leads cannot use spam fields.' }, { status: 400, headers: noStore })
  return Response.json({ lead: view(result.inquiry as unknown as Record<string, unknown>) }, { status: 201, headers: noStore })
}
