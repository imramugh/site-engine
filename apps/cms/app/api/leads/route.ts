import { getPayload } from 'payload'
import config from '../../../payload.config'
import { hasRole } from '../../../src/access'
import { createAcceptedInquiry, manualInquiryInput } from '../../../src/inquiries'
import { serverSessionStrategy } from '../../../src/identity'

export const dynamic = 'force-dynamic'

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
function view(inquiry: Record<string, unknown>) {
  // This DTO intentionally carries text only. Clients must render message and notes as text nodes.
  return inquiry
}

function filters(url: URL) {
  const stage = url.searchParams.get('stage')
  const urgent = url.searchParams.get('urgent')
  const assignee = url.searchParams.get('assignee')
  const clauses: Record<string, unknown>[] = []
  if (stage) clauses.push({ stage: { equals: stage } })
  if (urgent === 'true') clauses.push({ urgent: { equals: true } })
  if (assignee) clauses.push({ assignee: { equals: assignee } })
  return clauses.length ? { and: clauses } as never : undefined
}

function pageOf(value: string | null) { const parsed = Number(value ?? '1'); return Number.isInteger(parsed) && parsed > 0 ? parsed : 1 }

export async function GET(request: Request): Promise<Response> {
  const { payload, user } = await staff(request)
  if (!user) return Response.json({ error: 'Authentication required.' }, { status: 401 })
  const url = new URL(request.url)
  const page = pageOf(url.searchParams.get('page'))
  const result = await payload.find({ collection: 'inquiries', where: filters(url), sort: '-urgent,-updatedAt', limit: 50, page, depth: 0, overrideAccess: true })
  const users = await payload.find({ collection: 'users', where: { disabled: { not_equals: true } }, limit: 200, depth: 0, overrideAccess: true })
  const assignees = users.docs.filter((candidate) => hasRole(candidate as never, ['owner', 'sales'])).map((candidate) => ({ id: candidate.id, name: candidate.name || candidate.email, email: candidate.email }))
  const leads = result.docs.map((inquiry) => view(inquiry as unknown as Record<string, unknown>))
  const pipeline = Object.fromEntries(['new', 'qualified', 'contacted', 'proposal', 'won', 'lost'].map((stageName) => [stageName, leads.filter((lead) => lead.stage === stageName)]))
  return Response.json({ leads, pipeline, assignees, page: result.page, totalPages: result.totalPages, totalDocs: result.totalDocs, hasNextPage: result.hasNextPage, hasPrevPage: result.hasPrevPage }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403 })
  const { payload, user } = await staff(request)
  if (!user) return Response.json({ error: 'Authentication required.' }, { status: 401 })
  let body: unknown
  try { body = await request.json() } catch { return Response.json({ errors: { form: 'Send a valid lead.' } }, { status: 400 }) }
  const { input, errors } = manualInquiryInput(body)
  if (!input) return Response.json({ errors }, { status: 422 })
  const result = await createAcceptedInquiry(payload, input)
  if ('suppressed' in result) return Response.json({ error: 'Manual leads cannot use spam fields.' }, { status: 400 })
  return Response.json({ lead: view(result.inquiry as unknown as Record<string, unknown>) }, { status: 201 })
}
