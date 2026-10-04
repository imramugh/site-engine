import { hasRole, type Role } from './access'

type Actor = { id?: string; roles?: Role[] | null; disabled?: boolean | null } | null | undefined

type CountResult = { totalDocs: number }
type Release = { sequence?: number; activatedAt?: string; id: string }
type ChangeSet = { id: string; name?: string; state?: string; updatedAt?: string; quality?: unknown }
type DashboardPayload = {
  count: (args: any) => Promise<CountResult>
  find: (args: any) => Promise<{ docs: Array<Release | ChangeSet> }>
}

export type DashboardShortcut = { href: string; label: string }
export type AdminDashboardData = {
  state: 'ready' | 'unconfigured' | 'error'
  message?: string
  pendingReviews?: { total: number; items: DashboardReview[] }
  pages?: { total: number; draft: number; readiness: { state: 'available' | 'not-run'; issues: number }; withIssues: { state: 'unavailable'; message: string } }
  leads?: { new: number; urgent: number }
  latestRelease?: { sequence: number; activatedAt?: string }
  shortcuts: DashboardShortcut[]
}
export type DashboardReview = { id: string; name: string; state: string; updatedAt?: string; readiness: 'passed' | 'blocked' | 'not-run'; issues: number }

const editorialRoles: Role[] = ['owner', 'approver', 'editor']
const dashboardRoles: Role[] = ['owner', 'approver', 'editor', 'sales', 'hiring']

function reviewSummary(changeSet: ChangeSet): DashboardReview {
  const quality = changeSet.quality as { checks?: Array<{ status?: unknown; errors?: unknown }>; proof?: { report?: { blockers?: unknown[] } } } | undefined
  const checks = quality?.checks
  const errors = checks?.reduce((total, check) => total + (Array.isArray(check.errors) ? check.errors.length : 0), 0) ?? 0
  const blockers = Array.isArray(quality?.proof?.report?.blockers) ? quality!.proof!.report!.blockers!.length : 0
  const issues = errors + blockers
  const readiness = !checks?.length ? 'not-run' : issues > 0 || checks.some((check) => check.status === 'failed') ? 'blocked' : 'passed'
  return { id: changeSet.id, name: changeSet.name?.trim() || 'Unnamed change set', state: changeSet.state || 'submitted', updatedAt: changeSet.updatedAt, readiness, issues }
}

function shortcuts(actor: Actor): DashboardShortcut[] {
  const user = actor ?? undefined
  const items: DashboardShortcut[] = []
  if (hasRole(user, editorialRoles)) items.push({ href: '/content-tree', label: 'Content tree' }, { href: '/editorial', label: 'Change sets' })
  if (hasRole(user, ['owner', 'sales'])) items.push({ href: '/leads', label: 'Lead pipeline' })
  if (hasRole(user, ['owner', 'hiring'])) items.push({ href: '/applications', label: 'Applications' })
  if (hasRole(user, ['owner'])) items.push({ href: '/operations', label: 'Operations' })
  return items
}

/**
 * A deliberately small, server-only dashboard read model. Every collection is
 * queried only after the actor's role has been checked; the data is aggregate
 * only, so the dashboard cannot expose lead or applicant records by accident.
 */
export async function getAdminDashboardData(payload: DashboardPayload, actor: Actor): Promise<AdminDashboardData> {
  const user = actor ?? undefined
  const links = shortcuts(user)
  if (!hasRole(user, dashboardRoles)) return { state: 'error', message: 'Your session does not have access to the staff dashboard.', shortcuts: [] }

  try {
    const editorial = hasRole(user, editorialRoles)
    const leads = hasRole(user, ['owner', 'sales'])
    const queries: Promise<unknown>[] = []
    if (editorial) {
      queries.push(
        payload.count({ collection: 'change-sets', where: { state: { equals: 'submitted' } }, user, overrideAccess: false }),
        payload.find({ collection: 'change-sets', where: { state: { equals: 'submitted' } }, sort: '-updatedAt', limit: 5, depth: 0, user, overrideAccess: false }),
        payload.count({ collection: 'pages', user, overrideAccess: false }),
        payload.count({ collection: 'pages', where: { status: { equals: 'draft' } }, user, overrideAccess: false }),
        payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 0, user, overrideAccess: false }),
      )
    }
    if (leads) {
      queries.push(
        payload.count({ collection: 'inquiries', where: { stage: { equals: 'new' } }, user, overrideAccess: false }),
        payload.count({ collection: 'inquiries', where: { and: [{ urgent: { equals: true } }, { stage: { not_in: ['won', 'lost'] } }] }, user, overrideAccess: false }),
      )
    }
    const results = await Promise.all(queries)
    let cursor = 0
    const pendingTotal = editorial ? (results[cursor++] as CountResult).totalDocs : undefined
    const submitted = editorial ? (results[cursor++] as { docs: ChangeSet[] }).docs : undefined
    const totalPages = editorial ? (results[cursor++] as CountResult).totalDocs : undefined
    const draftPages = editorial ? (results[cursor++] as CountResult).totalDocs : undefined
    const releases = editorial ? (results[cursor++] as { docs: Release[] }).docs : undefined
    const newLeads = leads ? (results[cursor++] as CountResult).totalDocs : undefined
    const urgentLeads = leads ? (results[cursor++] as CountResult).totalDocs : undefined
    const release = releases?.[0]
    const reviews = submitted?.map(reviewSummary) ?? []
    const issues = reviews.reduce((total, review) => total + review.issues, 0)
    const unconfigured = editorial && totalPages === 0 && !release

    return {
      state: unconfigured ? 'unconfigured' : 'ready',
      ...(unconfigured ? { message: 'No content pages or published release have been configured yet.' } : {}),
      ...(editorial ? { pendingReviews: { total: pendingTotal!, items: reviews }, pages: { total: totalPages!, draft: draftPages!, readiness: { state: reviews.some((review) => review.readiness !== 'not-run') ? 'available' : 'not-run', issues }, withIssues: { state: 'unavailable', message: 'Readiness checks are stored for submitted change sets, not individual pages.' } }, latestRelease: release ? { sequence: Number(release.sequence), activatedAt: release.activatedAt } : undefined } : {}),
      ...(leads ? { leads: { new: newLeads!, urgent: urgentLeads! } } : {}),
      shortcuts: links,
    }
  } catch {
    return { state: 'error', message: 'Dashboard data could not be loaded. Reload the page or check the service configuration.', shortcuts: links }
  }
}
