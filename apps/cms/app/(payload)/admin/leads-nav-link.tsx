type LeadsNavProps = { user?: { roles?: string[] | null } }

export function LeadsNavLink({ user }: LeadsNavProps) {
  if (!user?.roles?.some((role) => role === 'owner' || role === 'sales')) return null
  return <a className="nav__link" href="/leads">Lead pipeline</a>
}
