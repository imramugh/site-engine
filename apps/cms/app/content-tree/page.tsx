import { getPayload } from 'payload'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import config from '../../payload.config'
import { hasRole } from '../../src/access'
import { serverSessionStrategy } from '../../src/identity'
import { StaffShell } from '../components/staff-shell'

type Page = { id: string; title: string; template: string; _status?: string | null; parentId?: string | { id?: string } | null; sectionId?: string | { id?: string } | null }
type Section = { id: string; name: string }
const idOf = (value: Page['parentId'] | Page['sectionId']) => typeof value === 'string' ? value : value?.id

export default async function ContentTreePage() {
  const payload = await getPayload({ config }); const user = (await serverSessionStrategy.authenticate({ headers: await headers(), payload })).user
  if (!hasRole(user as never, ['owner', 'editor', 'approver'])) redirect('/admin/login')
  const [sections, pages] = await Promise.all([payload.find({ collection: 'sections', limit: 100, depth: 0, draft: true, user, overrideAccess: false }), payload.find({ collection: 'pages', limit: 100, depth: 0, draft: true, user, overrideAccess: false })])
  const items = pages.docs as unknown as Page[]; const byParent = new Map<string, Page[]>(); const roots: Page[] = []
  for (const page of items) { const parent = idOf(page.parentId); if (parent && items.some(item => item.id === parent)) byParent.set(parent, [...(byParent.get(parent) ?? []), page]); else roots.push(page) }
  const render = (page: Page, seen = new Set<string>()): React.ReactNode => {
    const cycle = seen.has(page.id); const next = new Set(seen).add(page.id); const children = cycle ? [] : (byParent.get(page.id) ?? [])
    return <li key={page.id}><a href={`/admin/collections/pages/${page.id}`}>{page.title}</a> <span>{page._status ?? 'draft'} · {page.template}</span>{cycle ? <span role="note"> Hierarchy cycle detected.</span> : children.length ? <ul>{children.map(child => render(child, next))}</ul> : null}</li>
  }
  return <StaffShell><main><h1>Content tree</h1><p>Pages are grouped by their saved hierarchy. Select a page to edit it in the standard CMS form.</p>{(sections.docs as unknown as Section[]).map(section => <section key={section.id}><h2>{section.name}</h2><ul>{roots.filter(page => idOf(page.sectionId) === section.id).map(page => render(page))}</ul></section>)}{!items.length && <p role="status">No pages have been created.</p>}</main></StaffShell>
}
