import { hasRole, type Role } from './access'

type Actor = { id?: string; roles?: Role[] | null; disabled?: boolean | null } | null | undefined

type CountResult = { totalDocs: number }
type Release = { sequence?: number; activatedAt?: string; id: string }
type DashboardPayload = {
  count: (args: any) => Promise<CountResult>
  find: (args: any) => Promise<{ docs: Release[] }>
}

export type DashboardShortcut = { href: string; label: string }
export type AdminDashboardData = {
  state: 'ready' | 'unconfigured' | 'error'
  message?: string
  pendingReviews?: number
  pages?: { draft: number }
  leads?: { new: number; urgent: number }
  latestRelease?: { sequence: number; activatedAt?: string }
  shortcuts: DashboardShortcut[]
}

const editorialRoles: Role[] = ['owner', 'approver', 'editor']
const dashboardRoles: Role[] = ['owner', 'approver', 'editor', 'sales', 'hiring']

function shortcuts(actor: Actor): DashboardShortcut[] {
  const user = actor ?? undefined
  const items: DashboardShortcut[] = []
  if (hasRole(user, editorialRoles)) items.push({ href: '/admin/content-tree', label: 'Content tree' }, { href: '/admin/collections/change-sets', label: 'Change sets' })
  if (hasRole(user, ['owner', 'sales'])) items.push({ href: '/admin/leads', label: 'Lead pipeline' })
  if (hasRole(user, ['owner', 'hiring'])) items.push({ href: '/admin/applications', label: 'Applications' })
  if (hasRole(user, ['owner'])) items.push({ href: '/admin/operations', label: 'Operations' })
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
        payload.count({ collection: 'pages', where: { status: { equals: 'draft' } }, user, overrideAccess: false }),
        payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 0, user, overrideAccess: false }),
      )
    }
    if (leads) {
      queries.push(
        payload.count({ collection: 'inquiries', where: { stage: { equals: 'new' } }, user, overrideAccess: false }),
        payload.count({ collection: 'inquiries', where: { urgent: { equals: true } }, user, overrideAccess: false }),
      )
    }
    const results = await Promise.all(queries)
    let cursor = 0
    const pending = editorial ? (results[cursor++] as CountResult).totalDocs : undefined
    const draftPages = editorial ? (results[cursor++] as CountResult).totalDocs : undefined
    const releases = editorial ? (results[cursor++] as { docs: Release[] }).docs : undefined
    const newLeads = leads ? (results[cursor++] as CountResult).totalDocs : undefined
    const urgentLeads = leads ? (results[cursor++] as CountResult).totalDocs : undefined
    const release = releases?.[0]
    const unconfigured = editorial && draftPages === 0 && !release

    return {
      state: unconfigured ? 'unconfigured' : 'ready',
      ...(unconfigured ? { message: 'No content pages or published release have been configured yet.' } : {}),
      ...(editorial ? { pendingReviews: pending, pages: { draft: draftPages! }, latestRelease: release ? { sequence: Number(release.sequence), activatedAt: release.activatedAt } : undefined } : {}),
      ...(leads ? { leads: { new: newLeads!, urgent: urgentLeads! } } : {}),
      shortcuts: links,
    }
  } catch {
    return { state: 'error', message: 'Dashboard data could not be loaded. Reload the page or check the service configuration.', shortcuts: links }
  }
}
