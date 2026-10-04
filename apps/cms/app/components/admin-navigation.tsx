import type { CSSProperties } from 'react'
import { navigationForRoles, payloadCollectionItems, type AdminRole } from '../../src/admin-navigation'
import { loadAdminBranding } from '../../src/admin-branding'
import { AdminNavigationToggle, SkipNavigation } from './admin-navigation-toggle'
import styles from './staff-shell.module.css'

type AdminNavProps = { user?: WorkspaceUser | null }

export type WorkspaceUser = { name?: string | null; email?: string | null; roles?: string[] | null }

export async function WorkspaceNavigation({ user }: { user?: WorkspaceUser | null }) {
  const roles = user?.roles ?? []
  const branding = await loadAdminBranding()
  const items = navigationForRoles(roles)
  const collections = navigationForRoles(roles, payloadCollectionItems)
  const displayName = user?.name || user?.email || 'Staff account'

  return <aside className={styles.adminSidebar} data-admin-sidebar style={branding.tokens as CSSProperties} aria-label="Workspace navigation">
    {branding.stylesheetUrl ? <link rel="stylesheet" href={branding.stylesheetUrl} /> : null}
    <SkipNavigation />
    <a className={styles.adminBrand} href="/admin" aria-label={`${branding.name} overview`}>
      {branding.logoUrl ? <img src={branding.logoUrl} alt={branding.name} /> : <span aria-hidden="true">{branding.initials}</span>}
      <strong>{branding.name}</strong>
    </a>
    <AdminNavigationToggle items={items} collections={collections} displayName={displayName} roles={roles.filter((role): role is AdminRole => ['owner', 'editor', 'approver', 'sales', 'hiring'].includes(role))} />
  </aside>
}

export async function AdminNavigation({ user }: AdminNavProps) {
  return <WorkspaceNavigation user={user} />
}
