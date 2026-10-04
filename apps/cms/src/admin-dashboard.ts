import { checkSiteSnapshot } from '@site-engine/checks'
import { hasRole, type Role } from './access'

type Actor = { id?: string; roles?: Role[] | null; disabled?: boolean | null } | null | undefined
type DashboardPayload = {
  count: (args: any) => Promise<{ totalDocs: number }>
  find: (args: any) => Promise<{ docs: Array<any> }>
}
export type DashboardShortcut = { href: string; label: string }
export type DashboardReview = { id: string; name: string; state: string; updatedAt?: string; readiness: 'passed' | 'blocked' | 'not-run'; issues: number; changes: number }
export type DashboardIssue = { id: string; title: string; messages: string[]; severity: 'warning' | 'blocker' }
export type DashboardLead = { id: string; name: string; company?: string; note: string; tag: 'Urgent' | 'New' | 'Follow up' }
export type AdminDashboardData = {
  state: 'ready' | 'unconfigured' | 'error'
  message?: string
  pendingReviews?: { total: number; items: DashboardReview[] }
  pages?: { total: number; draft: number; readiness: { state: 'available' | 'not-run'; issues: number }; withIssues: { state: 'available' | 'unavailable'; total?: number; items: DashboardIssue[]; message: string } }
  leads?: { new: number; urgent: number; items: DashboardLead[] }
  latestRelease?: { sequence: number; activatedAt?: string }
  providers?: { configured: number; connected: number; testedAt?: string }
  actions: DashboardShortcut[]
  shortcuts: DashboardShortcut[]
}
const editorialRoles: Role[] = ['owner', 'approver', 'editor']
const dashboardRoles: Role[] = ['owner', 'approver', 'editor', 'sales', 'hiring']

function reviewSummary(set: any): DashboardReview {
  const checks = set.quality?.checks as Array<{ status?: string; errors?: unknown[] }> | undefined
  const errors = checks?.reduce((total, check) => total + (Array.isArray(check.errors) ? check.errors.length : 0), 0) ?? 0
  const issues = errors + (Array.isArray(set.quality?.proof?.report?.blockers) ? set.quality.proof.report.blockers.length : 0)
  return { id: set.id, name: set.name?.trim() || 'Unnamed change set', state: set.state || 'submitted', updatedAt: set.updatedAt, readiness: !checks?.length ? 'not-run' : issues || checks.some(check => check.status === 'failed') ? 'blocked' : 'passed', issues, changes: Array.isArray(set.changes) ? set.changes.length : 0 }
}
function actions(actor: Actor): DashboardShortcut[] {
  return [
    ...(hasRole(actor ?? undefined, ['owner', 'editor']) ? [{ href: '/admin/collections/pages/create', label: '+ New page' }, { href: '/admin/collections/assets/create', label: 'Upload media' }] : []),
    ...(hasRole(actor ?? undefined, ['owner']) ? [{ href: '/integrations', label: 'Connect an assistant' }] : []),
  ]
}
function shortcuts(actor: Actor): DashboardShortcut[] {
  const user = actor ?? undefined
  return [
    ...(hasRole(user, editorialRoles) ? [{ href: '/content-tree', label: 'Content tree' }, { href: '/editorial', label: 'Change sets' }] : []),
    ...(hasRole(user, ['owner', 'sales']) ? [{ href: '/leads', label: 'Lead pipeline' }] : []),
    ...(hasRole(user, ['owner', 'hiring']) ? [{ href: '/applications', label: 'Applications' }] : []),
    ...(hasRole(user, ['owner']) ? [{ href: '/operations', label: 'Operations' }] : []),
  ]
}

/** Readiness refers to the latest immutable published content, not stale review counts.
 * Checks run locally without changing a draft, review, release, or provider. */
function pageIssues(manifest: any): NonNullable<AdminDashboardData['pages']>['withIssues'] {
  if (!manifest) return { state: 'unavailable', items: [], message: 'No published content to check yet.' }
  const report = checkSiteSnapshot(manifest, { asOf: new Date() })
  const pages = new Map<string, any>((Array.isArray(manifest.pages) ? manifest.pages : []).map((page: any) => [page.id, page]))
  const grouped = new Map<string, DashboardIssue>()
  for (const issue of report.issues) {
    const page = issue.pageId ? pages.get(issue.pageId) : undefined
    if (!page) continue
    const entry: DashboardIssue = grouped.get(page.id) ?? { id: page.id, title: page.title, messages: [], severity: issue.severity }
    if (!entry.messages.includes(issue.message)) entry.messages.push(issue.message)
    if (issue.severity === 'blocker') entry.severity = 'blocker'
    grouped.set(page.id, entry)
  }
  // Invalid global configuration must never be represented as an all-clear page count.
  if (report.blockers.some(issue => !issue.pageId)) return { state: 'unavailable', items: [...grouped.values()].slice(0, 5), message: 'Site configuration needs review before page checks can complete.' }
  return { state: 'available', total: grouped.size, items: [...grouped.values()].sort((a, b) => a.severity.localeCompare(b.severity) || a.title.localeCompare(b.title)).slice(0, 5), message: 'Checks on the latest published content.' }
}

/** Each private query is role-gated before it runs; collection access rules remain active.
 * The owner-only provider projection excludes credentials and never calls a provider. */
export async function getAdminDashboardData(payload: DashboardPayload, actor: Actor): Promise<AdminDashboardData> {
  const user = actor ?? undefined
  if (!hasRole(user, dashboardRoles)) return { state: 'error', message: 'Your session does not have access to the staff dashboard.', shortcuts: [], actions: [] }
  const result: AdminDashboardData = { state: 'ready', actions: actions(user), shortcuts: shortcuts(user) }
  try {
    const tasks: Promise<void>[] = []
    if (hasRole(user, editorialRoles)) tasks.push((async () => {
      const access = { user, overrideAccess: false, depth: 0 }
      const [pending, submitted, total, drafts, releases] = await Promise.all([
        payload.count({ collection: 'change-sets', where: { state: { equals: 'submitted' } }, ...access }),
        payload.find({ collection: 'change-sets', where: { state: { equals: 'submitted' } }, sort: 'updatedAt', limit: 5, ...access }),
        payload.count({ collection: 'pages', ...access }),
        payload.count({ collection: 'pages', where: { status: { equals: 'draft' } }, ...access }),
        payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, ...access }),
      ])
      const release = releases.docs[0]
      const snapshotID = typeof release?.snapshot === 'string' ? release.snapshot : release?.snapshot?.id
      const manifest = snapshotID ? (await payload.find({ collection: 'publish-snapshots', where: { id: { equals: snapshotID } }, limit: 1, ...access })).docs[0]?.manifest : undefined
      const withIssues = pageIssues(manifest)
      const items = submitted.docs.map(reviewSummary)
      result.pendingReviews = { total: pending.totalDocs, items }
      result.pages = { total: total.totalDocs, draft: drafts.totalDocs, withIssues, readiness: { state: items.some(item => item.readiness !== 'not-run') ? 'available' : 'not-run', issues: items.reduce((sum, item) => sum + item.issues, 0) } }
      if (release) result.latestRelease = { sequence: Number(release.sequence), activatedAt: release.activatedAt }
      if (!total.totalDocs && !release) { result.state = 'unconfigured'; result.message = 'No content pages or published release have been configured yet.' }
    })())
    if (hasRole(user, ['owner', 'sales'])) tasks.push((async () => {
      const access = { user, overrideAccess: false, depth: 0 }
      const active = { stage: { not_in: ['won', 'lost'] } }
      const [fresh, urgent, records] = await Promise.all([
        payload.count({ collection: 'inquiries', where: { stage: { equals: 'new' } }, ...access }),
        payload.count({ collection: 'inquiries', where: { and: [{ urgent: { equals: true } }, active] }, ...access }),
        payload.find({ collection: 'inquiries', where: { and: [active, { or: [{ urgent: { equals: true } }, { stage: { equals: 'new' } }, { nextAction: { exists: true } }] }] }, sort: ['-urgent', 'createdAt'], limit: 5, select: { name: true, company: true, email: true, nextAction: true, topic: true, stage: true, urgent: true }, ...access }),
      ])
      result.leads = { new: fresh.totalDocs, urgent: urgent.totalDocs, items: records.docs.map(record => ({ id: record.id, name: record.name?.trim() || record.email, company: record.company || undefined, note: record.nextAction?.trim() || (record.urgent ? 'Active incident · follow-up needed' : 'New inquiry · follow-up needed'), tag: record.urgent ? 'Urgent' : record.stage === 'new' ? 'New' : 'Follow up' })) }
    })())
    if (hasRole(user, ['owner'])) tasks.push((async () => {
      const records = await payload.find({ collection: 'integration-configurations', limit: 20, depth: 0, overrideAccess: true, select: { provider: true, health: true, testedAt: true } })
      result.providers = { configured: records.docs.filter(record => record.health !== 'revoked').length, connected: records.docs.filter(record => record.health === 'connected').length, testedAt: records.docs.map(record => record.testedAt).filter(Boolean).sort().at(-1) }
    })())
    await Promise.all(tasks)
    return result
  } catch {
    return { state: 'error', message: 'Dashboard data could not be loaded. Reload the page or check the service configuration.', shortcuts: result.shortcuts, actions: result.actions }
  }
}
