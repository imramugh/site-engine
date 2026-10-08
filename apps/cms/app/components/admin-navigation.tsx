import type { CSSProperties } from 'react'
import { adminSiteNavigationItems, navigationBadges, navigationForRoles, type AdminRole } from '../../src/admin-navigation'
import { getPayload } from 'payload'
import config from '../../payload.config'
import { loadAdminBranding } from '../../src/admin-branding'
import { AdminNavigationToggle, AdminWorkspaceHeader, SkipNavigation } from './admin-navigation-toggle'
import styles from './staff-shell.module.css'

type AdminNavProps = { user?: WorkspaceUser | null }

export type WorkspaceUser = { id?: string | number | null; name?: string | null; email?: string | null; roles?: string[] | null; provider?: string | null; disabled?: boolean | null }

export async function WorkspaceNavigation({ user }: { user?: WorkspaceUser | null }) {
  const roles = user?.roles ?? []
  const branding = await loadAdminBranding()
  const primary = navigationForRoles(roles)
  const site = navigationForRoles(roles, adminSiteNavigationItems)
  const displayName = user?.name || user?.email || 'Staff account'
  const acceptedRoles = roles.filter((role): role is AdminRole => ['owner', 'editor', 'approver', 'sales', 'hiring'].includes(role))
  const payload = await getPayload({ config })
  const badges = await navigationBadges(payload, { id: user?.id, roles: acceptedRoles, disabled: user?.disabled })

  return <>
    {branding.stylesheetUrl ? <link rel="stylesheet" href={branding.stylesheetUrl} /> : null}
    <SkipNavigation />
    <aside className={styles.adminSidebar} data-admin-sidebar aria-label="Workspace navigation" style={branding.tokens as CSSProperties}>
      <a className={styles.adminBrand} data-admin-brand href="/admin">
        {branding.logoUrl ? <img src={branding.logoUrl} alt="" /> : <span aria-hidden="true">{branding.initials}</span>}
        <span className={styles.srOnly}>{branding.name}</span>
        <strong aria-hidden="true">{branding.name}</strong>
      </a>
      <AdminNavigationToggle primary={primary} site={site} displayName={displayName} email={user?.email ?? ''} provider={user?.provider ?? null} roles={acceptedRoles} badges={badges} />
    </aside>
    <AdminWorkspaceHeader />
  </>
}

export async function AdminNavigation({ user }: AdminNavProps) {
  return <WorkspaceNavigation user={user} />
}
