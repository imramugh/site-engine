import type { CSSProperties } from 'react'
import { adminSiteNavigationItems, adminToolNavigationItems, navigationForRoles, payloadCollectionItems, type AdminRole } from '../../src/admin-navigation'
import { loadAdminBranding } from '../../src/admin-branding'
import { AdminNavigationToggle, AdminWorkspaceHeader, SkipNavigation } from './admin-navigation-toggle'
import styles from './staff-shell.module.css'

type AdminNavProps = { user?: WorkspaceUser | null }

export type WorkspaceUser = { name?: string | null; email?: string | null; roles?: string[] | null }

export async function WorkspaceNavigation({ user }: { user?: WorkspaceUser | null }) {
  const roles = user?.roles ?? []
  const branding = await loadAdminBranding()
  const primary = navigationForRoles(roles)
  const site = navigationForRoles(roles, adminSiteNavigationItems)
  const tools = navigationForRoles(roles, adminToolNavigationItems)
  const collections = navigationForRoles(roles, payloadCollectionItems)
  const displayName = user?.name || user?.email || 'Staff account'
  const acceptedRoles = roles.filter((role): role is AdminRole => ['owner', 'editor', 'approver', 'sales', 'hiring'].includes(role))

  return <>
    {branding.stylesheetUrl ? <link rel="stylesheet" href={branding.stylesheetUrl} /> : null}
    <SkipNavigation />
    <aside className={styles.adminSidebar} data-admin-sidebar aria-label="Workspace navigation" style={branding.tokens as CSSProperties}>
      <a className={styles.adminBrand} data-admin-brand href="/admin" aria-label={`${branding.name} dashboard`}>
        {branding.logoUrl ? <img src={branding.logoUrl} alt={branding.name} /> : <span aria-hidden="true">{branding.initials}</span>}
        <strong>{branding.name}</strong>
      </a>
      <AdminNavigationToggle primary={primary} site={site} tools={tools} collections={collections} displayName={displayName} roles={acceptedRoles} />
    </aside>
    <AdminWorkspaceHeader />
  </>
}

export async function AdminNavigation({ user }: AdminNavProps) {
  return <WorkspaceNavigation user={user} />
}
