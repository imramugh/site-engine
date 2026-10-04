type EditorialNavProps = { user?: { roles?: string[] | null } }

export function EditorialNavLink({ user }: EditorialNavProps) {
  const editorial = user?.roles?.some((role) => role === 'owner' || role === 'approver' || role === 'editor')
  const hiring = user?.roles?.some((role) => role === 'owner' || role === 'hiring')
  const sales = user?.roles?.some((role) => role === 'owner' || role === 'sales')
  const owner = user?.roles?.includes('owner')
  if (!editorial && !hiring && !sales) return null
  return <>
    {owner && <a className="nav__link" href="/operations">Operations</a>}
    {owner && <a className="nav__link" href="/themes">Themes</a>}
    {editorial && <a className="nav__link" href="/content-tree">Content tree</a>}
    {editorial && <a className="nav__link" href="/block-gallery">Block gallery</a>}
    {editorial && <a className="nav__link" href="/admin/editorial">Editorial review</a>}
    {sales && <a className="nav__link" href="/leads">Lead pipeline</a>}
    {hiring && <a className="nav__link" href="/applications">Applications</a>}
  </>
}
