import { getPayload } from 'payload'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import config from '../../../payload.config'
import { hasRole } from '../../../src/access'
import { buildContentTree, type ContentTreeNode, type ContentTreePage, type ContentTreeSection } from '../../../src/content-tree'
import { serverSessionStrategy } from '../../../src/identity'
import { StaffShell } from '../../components/staff-shell'
import styles from './content-list.module.css'

type Filter = 'all' | 'draft' | 'archived'
type Row = { page: ContentTreePage; indent: number; path: string; cycle: boolean; group: string }
const filters: Array<{ value: Filter; label: string }> = [{ value: 'all', label: 'All pages' }, { value: 'draft', label: 'Drafts' }, { value: 'archived', label: 'Archived' }]
const stateOf = (page: ContentTreePage) => page.status ?? page._status ?? 'draft'

function Icon({ folder }: { folder: boolean }) {
  return folder
    ? <svg className={styles.glyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
    : <svg className={styles.glyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8M8 17h8" /></svg>
}
function append(nodes: ContentTreeNode[], rows: Row[], section: ContentTreeSection | undefined, ancestors: string[], depth = 0, group = '') {
  for (const node of nodes) {
    const title = node.page.title || 'Untitled page'
    rows.push({ page: node.page, indent: depth, path: `/${[...ancestors, node.page.slug || node.page.id].join('/')}`, cycle: node.cycle, group })
    append(node.children, rows, section, [...ancestors, node.page.slug || node.page.id], depth + 1, group)
  }
}
function rowsFor(sections: ContentTreeSection[], tree: ReturnType<typeof buildContentTree>) {
  const rows: Row[] = []
  for (const group of tree.sections) {
    const section = sections.find((item) => item.id === group.section.id)
    append(group.roots, rows, section, [String(section?.slug ?? '')].filter(Boolean), 0, group.section.name)
    append(group.unplaced, rows, section, [String(section?.slug ?? '')].filter(Boolean), 0, `${group.section.name} — hierarchy needs repair`)
  }
  append(tree.unassigned, rows, undefined, [], 0, 'Unassigned pages')
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
    const [sections, pages] = await Promise.all([
      payload.find({ collection: 'sections', limit: 0, pagination: false, depth: 0, draft: true, user, overrideAccess: false }),
      payload.find({ collection: 'pages', limit: 0, pagination: false, depth: 0, draft: true, user, overrideAccess: false }),
    ])
    const allPages = pages.docs as unknown as ContentTreePage[]
    const allRows = rowsFor(sections.docs as unknown as ContentTreeSection[], buildContentTree(sections.docs as unknown as ContentTreeSection[], allPages))
    const counts = { all: allRows.length, draft: allRows.filter((row) => stateOf(row.page) === 'draft').length, archived: allRows.filter((row) => stateOf(row.page) === 'archived').length }
    const visible = allRows.filter((row) => (filter === 'all' || stateOf(row.page) === filter) && (!search || `${row.page.title} ${row.page.slug} ${row.path}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())))
    const canCreate = hasRole(user as never, ['owner', 'editor'])
    return <StaffShell><main data-content-tree>
      <h1>Content tree</h1>
      <p>Browse the saved page hierarchy and open a page in the standard CMS form.</p>
      <section className={styles.contentList} aria-label="Content pages" data-content-list data-testid="content-list">
        <div className={styles.toolbar}>
          <nav className={styles.tabs} aria-label="Page status" data-content-tabs>{filters.map((item) => <a key={item.value} className={styles.tab} href={hrefFor(item.value, search)} aria-current={filter === item.value ? 'page' : undefined} data-content-tab={item.value}>{item.label} ({counts[item.value]})</a>)}</nav>
          {canCreate ? <a className={styles.newPage} href="/admin/collections/pages/create" data-content-new-page>+ New page</a> : null}
        </div>
        <form className={styles.filters} action="/content-tree" method="get" role="search" data-content-search>
          {filter !== 'all' ? <input type="hidden" name="status" value={filter} /> : null}
          <label htmlFor="content-tree-search">Search pages</label><input id="content-tree-search" name="q" defaultValue={search} placeholder="Title or path" /><button type="submit">Search</button>
        </form>
        <div className={styles.tableWrap} tabIndex={0} aria-label="Page list. Scroll horizontally for all columns on small screens." data-content-table-scroll data-testid="content-table-scroll">
          <table className={styles.table} data-content-table><caption className={styles.visuallyHidden}>Pages matching the selected status and search</caption><thead><tr><th scope="col">Page</th><th scope="col">Template</th><th scope="col">Status</th><th scope="col">Checks</th><th scope="col">Updated</th></tr></thead><tbody>
            {visible.map((row) => <tr className={styles.tableRow} key={`${row.group}:${row.page.id}`} data-content-row data-content-status={stateOf(row.page)}><td><a className={styles.pageLink} href={`/admin/collections/pages/${row.page.id}`} style={{ paddingLeft: `${row.indent * 1.25}rem` }} data-content-page-link><Icon folder={row.indent === 0} /><span className={styles.title}>{row.page.title || 'Untitled page'}</span><span className={styles.path}>{row.path}</span>{row.cycle ? <span role="note">Hierarchy cycle</span> : null}</a></td><td className={styles.template}>{row.page.template}</td><td><span className={styles.status} data-status={stateOf(row.page)}>{stateOf(row.page)}</span></td><td><span className={styles.notChecked}>Not checked</span></td><td className={styles.updated}>{formatDate(row.page.updatedAt)}</td></tr>)}
          </tbody></table>
        </div>
        {!visible.length ? <p className={styles.notice} role="status" data-content-empty data-testid="content-empty">{allRows.length ? 'No pages match these filters.' : 'No pages have been created.'}</p> : null}
      </section>
    </main></StaffShell>
  } catch {
    return <StaffShell><main data-content-tree><h1>Content tree</h1><p role="alert" data-content-error>Pages could not be loaded. Reload the page or check the content service.</p></main></StaffShell>
  }
}
