import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { hasRole } from '../../../../src/access'
import { csvEscape } from '../../../../src/inquiries'
import { serverSessionStrategy } from '../../../../src/identity'
import { LeadFilterError, leadWhere, parseLeadFilters } from '../../../../src/lead-filters'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  if (!hasRole(authenticated.user as never, ['owner', 'sales'])) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
  const url = new URL(request.url)
  let filters
  try { filters = parseLeadFilters(url) } catch (error) {
    if (error instanceof LeadFilterError) return Response.json({ error: error.message }, { status: 400, headers: noStore })
    throw error
  }
  filters.spam = false
  const result = await payload.find({ collection: 'inquiries', where: leadWhere(filters, true), sort: '-urgent,-updatedAt', limit: 10_000, depth: 0, overrideAccess: true })
  const columns = ['id', 'email', 'name', 'telephone', 'company', 'topic', 'sourcePage', 'message', 'stage', 'urgent', 'notes', 'nextAction', 'assignee', 'createdAt']
  const csv = [columns.join(','), ...result.docs.map((lead) => columns.map((column) => csvEscape((lead as unknown as Record<string, unknown>)[column])).join(','))].join('\r\n')
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads.csv"', 'Cache-Control': 'no-store' } })
}
