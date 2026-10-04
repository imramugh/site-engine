import { getPayload } from 'payload'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import config from '../../../payload.config'
import { hasRole } from '../../../src/access'
import { checkForWorkingPage, publishedPageChecks, workingPageState, type PublishedPageCheck } from '../../../src/content-readiness'
import { buildContentTree, canonicalContentPath, type ContentTreeNode, type ContentTreePage, type ContentTreeSection } from '../../../src/content-tree'
import { serverSessionStrategy } from '../../../src/identity'
import { StaffShell } from '../../components/staff-shell'
import styles from './content-list.module.css'

type Filter = 'all' | 'draft' | 'archived'
type Row = { page: ContentTreePage; indent: number; path: string; cycle: boolean; hasChildren: boolean; group: string; check: PublishedPageCheck }
const filters: Array<{ value: Filter; label: string }> = [{ value: 'all', label: 'All pages' }, { value: 'draft', label: 'Drafts' }, { value: 'archived', label: 'Archived' }]
const statusLabel = (status: string) => ({ published: 'Published', 'draft-changes': 'Draft changes', draft: 'Draft', archived: 'Archived' })[status] ?? status

function Glyph({ hasChildren, depth }: { hasChildren: boolean; depth: number }) {
  if (hasChildren) return <svg className={styles.glyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 9 5 7 5-7Z" fill="currentColor" stroke="none" /></svg>
  if (depth > 0) return <svg className={styles.glyph} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="1.25" /></svg>
  return <svg className={styles.glyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="6" /></svg>
}
function append(nodes: ContentTreeNode[], rows: Row[], pages: ContentTreePage[], sections: ContentTreeSection[], homepageID: string | undefined, checks: Map<string, PublishedPageCheck> | undefined, depth = 0, group = '') {
  for (const node of nodes) {
    rows.push({ page: node.page, indent: depth, path: canonicalContentPath(node.page, pages, sections, homepageID) ?? 'Route unavailable', cycle: node.cycle, hasChildren: node.children.length > 0, group, check: checkForWorkingPage(node.page, checks) })
    append(node.children, rows, pages, sections, homepageID, checks, depth + 1, group)
  }
}
function rowsFor(sections: ContentTreeSection[], pages: ContentTreePage[], homepageID: string | undefined, checks: Map<string, PublishedPageCheck> | undefined, tree: ReturnType<typeof buildContentTree>) {
  const rows: Row[] = []
  for (const group of tree.sections) {
    append(group.roots, rows, pages, sections, homepageID, checks, 0, group.section.name)
    append(group.unplaced, rows, pages, sections, homepageID, checks, 0, `${group.section.name} — hierarchy needs repair`)
  }
  append(tree.unassigned, rows, pages, sections, homepageID, checks, 0, 'Unassigned pages')
  return rows
}
function formatDate(value: unknown) {
  if (typeof value !== 'string') return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Not recorded' : new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeZone: 'America/Toronto' }).format(date)
}
function hrefFor(filter: Filter, search: string) { const params = new URLSearchParams(); if (filter !== 'all') params.set('status', filter); if (search) params.set('q', search); const query = params.toString(); return `/content-tree${query ? `?${query}` : ''}` }

export default async function ContentTreePage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const payload = await getPayload({ config })
  const user = (await serverSessionStrategy.authenticate({ headers: await headers(), payload })).user
  if (!hasRole(user as never, ['owner', 'editor', 'approver'])) redirect('/admin/login')
  const input = await searchParams
  const filter: Filter = input.status === 'draft' || input.status === 'archived' ? input.status : 'all'
  const search = typeof input.q === 'string' ? input.q.trim().slice(0, 120) : ''
  try {
    const [sections, pages, settings, releases] = await Promise.all([
      payload.find({ collection: 'sections', limit: 0, pagination: false, depth: 0, draft: true, user, overrideAccess: false }),
      payload.find({ collection: 'pages', limit: 0, pagination: false, depth: 0, draft: true, user, overrideAccess: false }),
      payload.find({ collection: 'site-settings', where: { key: { equals: 'active' } }, limit: 1, depth: 0, draft: true, user, overrideAccess: false }),
      payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 0, user, overrideAccess: false }),
    ])
    const allPages = pages.docs as unknown as ContentTreePage[]
    const contentSections = sections.docs as unknown as ContentTreeSection[]
    const homepage = settings.docs[0]?.homepageId
    const homepageID = typeof homepage === 'string' ? homepage : homepage?.id
    const release = releases.docs[0]
    const snapshotID = typeof release?.snapshot === 'string' ? release.snapshot : release?.snapshot?.id
    const snapshot = snapshotID ? await payload.find({ collection: 'publish-snapshots', where: { id: { equals: snapshotID } }, limit: 1, depth: 0, user, overrideAccess: false }) : undefined
    const manifest = snapshot?.docs[0]?.manifest as { pages?: Record<string, unknown>[] } | undefined
    const checks = publishedPageChecks(manifest)
    const releasedPages = new Map((Array.isArray(manifest?.pages) ? manifest.pages : []).map((item) => [item.id, item]))
    const stateOf = (page: ContentTreePage) => workingPageState(page as unknown as Record<string, unknown>, releasedPages.get(page.id))
    const matchesDraft = (page: ContentTreePage) => ['draft', 'draft-changes'].includes(stateOf(page))
    const allRows = rowsFor(contentSections, allPages, homepageID, checks, buildContentTree(contentSections, allPages))
    const counts = { all: allRows.length, draft: allRows.filter((row) => matchesDraft(row.page)).length, archived: allRows.filter((row) => stateOf(row.page) === 'archived').length }
    const visible = allRows.filter((row) => (filter === 'all' || (filter === 'draft' ? matchesDraft(row.page) : stateOf(row.page) === filter)) && (!search || `${row.page.title} ${row.page.slug} ${row.path}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())))
    const canCreate = hasRole(user as never, ['owner', 'editor'])
    const pageHref = (id: string) => canCreate ? `/content-editor/${id}` : `/admin/collections/pages/${id}`
    return <StaffShell><main data-content-tree>
      <h1 className={styles.visuallyHidden}>Content</h1>
      <section className={styles.contentList} aria-label="Content pages" data-content-list data-testid="content-list">
        <div className={styles.toolbar}>
          <nav className={styles.tabs} aria-label="Page status" data-content-tabs>{filters.map((item) => <a key={item.value} className={styles.tab} href={hrefFor(item.value, search)} aria-current={filter === item.value ? 'page' : undefined} data-content-tab={item.value}>{item.label} ({counts[item.value]})</a>)}</nav>
          {canCreate ? <a className={styles.newPage} href="/admin/collections/pages/create" data-content-new-page>+ New page</a> : null}
        </div>
        <div className={styles.tableWrap} tabIndex={0} aria-label="Page list. Scroll horizontally for all columns on small screens." data-content-table-scroll data-testid="content-table-scroll">
          <table className={styles.table} data-content-table><caption className={styles.visuallyHidden}>Pages matching the selected status and search</caption><thead><tr><th scope="col">Page</th><th scope="col">Template</th><th scope="col">Status</th><th scope="col">Checks</th><th scope="col">Updated</th></tr></thead><tbody>
            {visible.map((row) => <tr className={styles.tableRow} key={`${row.group}:${row.page.id}`} data-content-row data-content-status={stateOf(row.page)}><td><a className={styles.pageLink} href={pageHref(row.page.id)} style={{ paddingLeft: `${row.indent * 1.25}rem` }} data-content-page-link><Glyph hasChildren={row.hasChildren} depth={row.indent} /><span className={styles.title}>{row.page.title || 'Untitled page'}</span><span className={styles.path}>{row.path}</span>{row.cycle ? <span role="note">Hierarchy cycle</span> : null}</a></td><td className={styles.template}>{row.page.template}</td><td><span className={styles.status} data-status={stateOf(row.page)}>{statusLabel(stateOf(row.page))}</span></td><td>{row.check.state === 'checked' ? row.check.issues ? <a className={styles.checkIssue} href={pageHref(row.page.id)} data-content-check="issues" title="These checks describe the latest published version. Draft changes require a new readiness check.">Published: {row.check.issues} issue{row.check.issues === 1 ? '' : 's'}</a> : <span className={styles.checkPassed} data-content-check="passed" title="These checks describe the latest published version. Draft changes require a new readiness check.">Published: passed</span> : <span className={styles.notChecked} data-content-check={row.check.state}>{row.check.state === 'not-published' ? 'Draft: not checked' : 'Checks unavailable'}</span>}</td><td className={styles.updated}>{formatDate(row.page.updatedAt)}</td></tr>)}
          </tbody></table>
        </div>
        {!visible.length ? <p className={styles.notice} role="status" data-content-empty data-testid="content-empty">{allRows.length ? 'No pages match these filters.' : 'No pages have been created.'}</p> : null}
      </section>
    </main></StaffShell>
  } catch {
    return <StaffShell><main data-content-tree><p role="alert" data-content-error>Pages could not be loaded. Reload the page or check the content service.</p></main></StaffShell>
  }
}
