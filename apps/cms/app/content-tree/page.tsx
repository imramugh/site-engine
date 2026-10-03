import { getPayload } from 'payload'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import config from '../../payload.config'
import { hasRole } from '../../src/access'
import { buildContentTree, type ContentTreeNode, type ContentTreePage, type ContentTreeSection } from '../../src/content-tree'
import { serverSessionStrategy } from '../../src/identity'
import { StaffShell } from '../components/staff-shell'

function PageNode({ node }: { node: ContentTreeNode }) {
  const { page } = node
  return <li>
    <a href={`/admin/collections/pages/${page.id}`}>{page.title}</a> <span>{page._status ?? 'draft'} · {page.template}</span>
    {node.cycle ? <span role="note"> Hierarchy cycle detected.</span> : null}
    {node.children.length ? <ul>{node.children.map((child) => <PageNode key={`${page.id}:${child.page.id}`} node={child} />)}</ul> : null}
  </li>
}

function PageList({ nodes }: { nodes: ContentTreeNode[] }) {
  return nodes.length ? <ul>{nodes.map((node, index) => <PageNode key={`${node.page.id}:${index}`} node={node} />)}</ul> : null
}

export default async function ContentTreePage() {
  const payload = await getPayload({ config })
  const user = (await serverSessionStrategy.authenticate({ headers: await headers(), payload })).user
  if (!hasRole(user as never, ['owner', 'editor', 'approver'])) redirect('/admin/login')
  const [sections, pages] = await Promise.all([
    payload.find({ collection: 'sections', limit: 0, pagination: false, depth: 0, draft: true, user, overrideAccess: false }),
    payload.find({ collection: 'pages', limit: 0, pagination: false, depth: 0, draft: true, user, overrideAccess: false }),
  ])
  const tree = buildContentTree(sections.docs as unknown as ContentTreeSection[], pages.docs as unknown as ContentTreePage[])
  const hasPages = pages.docs.length > 0
  return <StaffShell><main>
    <h1>Content tree</h1>
    <p>Pages are grouped by their saved hierarchy. Select a page to edit it in the standard CMS form.</p>
    {tree.sections.map(({ section, roots, unplaced }) => <section key={section.id}>
      <h2>{section.name}</h2>
      <PageList nodes={roots} />
      {unplaced.length ? <><h3>Unplaced pages</h3><p role="note">These pages have a cyclic or otherwise malformed hierarchy.</p><PageList nodes={unplaced} /></> : null}
    </section>)}
    {tree.unassigned.length ? <section><h2>Unassigned pages</h2><p role="note">These pages reference a section that is unavailable.</p><PageList nodes={tree.unassigned} /></section> : null}
    {!hasPages ? <p role="status">No pages have been created.</p> : null}
  </main></StaffShell>
}
