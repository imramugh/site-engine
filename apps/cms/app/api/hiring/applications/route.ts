import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { hasRole } from '../../../../src/access'
import { serverSessionStrategy } from '../../../../src/identity'

export const dynamic = 'force-dynamic'
const stages = ['new', 'reviewing', 'interview', 'offer', 'hired', 'declined', 'closed'] as const
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  const user = authenticated.user as { id?: string; roles?: ('owner' | 'hiring')[]; disabled?: boolean } | null
  if (!user || !hasRole(user, ['owner', 'hiring'])) return Response.json({ error: 'Authentication required.' }, { status: 403 })
  const query = new URL(request.url).searchParams
  const stage = query.get('stage') ?? ''
  const jobId = query.get('jobId') ?? ''
  const page = Number(query.get('page') ?? '1')
  if ((stage && !stages.includes(stage as typeof stages[number])) || (jobId && !id.test(jobId)) || !Number.isSafeInteger(page) || page < 1) return Response.json({ error: 'Invalid application filters.' }, { status: 400 })
  const clauses: Record<string, unknown>[] = []
  if (stage) clauses.push({ status: { equals: stage } })
  if (jobId) clauses.push({ jobId: { equals: jobId } })
  const where = clauses.length > 1 ? { and: clauses } : clauses[0]
  const roleWhere = jobId ? { jobId: { equals: jobId } } : undefined
  const [result, all, ...counts] = await Promise.all([
    payload.find({ collection: 'applications', where: where as never, sort: '-createdAt', limit: 25, page, depth: 0, user, overrideAccess: false }),
    payload.count({ collection: 'applications', user, overrideAccess: false }),
    ...stages.map((status) => payload.count({ collection: 'applications', where: roleWhere ? { and: [roleWhere, { status: { equals: status } }] } as never : { status: { equals: status } }, user, overrideAccess: false })),
  ])
  return Response.json({
    docs: result.docs.map((application) => ({ id: application.id, name: application.name, email: application.email, telephone: application.telephone ?? null, linkedIn: application.linkedIn ?? null, coverLetter: application.coverLetter, consent: application.consent, jobId: application.jobId, status: application.status, createdAt: application.createdAt })),
    page: result.page,
    totalPages: result.totalPages,
    totalDocs: result.totalDocs,
    allTotalDocs: all.totalDocs,
    stageCounts: Object.fromEntries(stages.map((status, index) => [status, counts[index]?.totalDocs ?? 0])),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
