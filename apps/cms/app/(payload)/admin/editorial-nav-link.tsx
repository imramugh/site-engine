type EditorialNavProps = { user?: { roles?: string[] | null } }

export function EditorialNavLink({ user }: EditorialNavProps) {
  const editorial = user?.roles?.some((role) => role === 'owner' || role === 'approver' || role === 'editor')
  const hiring = user?.roles?.some((role) => role === 'owner' || role === 'hiring')
  if (!editorial && !hiring) return null
  return <>{editorial && <a className="nav__link" href="/admin/editorial">Editorial review</a>}{hiring && <a className="nav__link" href="/applications">Applications</a>}</>
}
