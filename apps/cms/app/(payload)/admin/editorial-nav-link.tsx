type EditorialNavProps = { user?: { roles?: string[] | null } }

export function EditorialNavLink({ user }: EditorialNavProps) {
  if (!user?.roles?.some((role) => role === 'owner' || role === 'approver' || role === 'editor')) return null
  return <a className="nav__link" href="/admin/editorial">Editorial review</a>
}
