import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { hasRole } from '../../../../src/access'
import { csvEscape } from '../../../../src/inquiries'
import { serverSessionStrategy } from '../../../../src/identity'

export const dynamic = 'force-dynamic'

function filters(url: URL) {
  const clauses: Record<string, unknown>[] = []
  const stage = url.searchParams.get('stage'); const urgent = url.searchParams.get('urgent'); const assignee = url.searchParams.get('assignee')
  if (stage) clauses.push({ stage: { equals: stage } })
  if (urgent === 'true') clauses.push({ urgent: { equals: true } })
  if (assignee) clauses.push({ assignee: { equals: assignee } })
  return clauses.length ? { and: clauses } as never : undefined
}

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  if (!hasRole(authenticated.user as never, ['owner', 'sales'])) return Response.json({ error: 'Authentication required.' }, { status: 401 })
  const url = new URL(request.url)
  const result = await payload.find({ collection: 'inquiries', where: filters(url), sort: '-urgent,-updatedAt', limit: 10_000, depth: 0, overrideAccess: true })
  const columns = ['id', 'email', 'name', 'telephone', 'company', 'topic', 'sourcePage', 'message', 'stage', 'urgent', 'notes', 'nextAction', 'assignee', 'createdAt']
  const csv = [columns.join(','), ...result.docs.map((lead) => columns.map((column) => csvEscape((lead as unknown as Record<string, unknown>)[column])).join(','))].join('\r\n')
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads.csv"', 'Cache-Control': 'no-store' } })
}
