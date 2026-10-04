export type AdminRole = 'owner' | 'editor' | 'approver' | 'sales' | 'hiring'

export type AdminNavigationItem = {
  href: string
  label: string
  roles: readonly AdminRole[]
}

const allStaff: readonly AdminRole[] = ['owner', 'editor', 'approver', 'sales', 'hiring']

/**
 * Discovery is role-aware, but route handlers and collection access remain the
 * authority for direct requests. The primary order is intentionally stable so
 * staff retain a consistent workspace across the Payload and staff routes.
 */
export const adminNavigationItems: readonly AdminNavigationItem[] = [
  { href: '/admin', label: 'Dashboard', roles: allStaff },
  { href: '/content-tree', label: 'Content', roles: ['owner', 'editor', 'approver'] },
  { href: '/block-gallery', label: 'Block gallery', roles: ['owner', 'editor'] },
  { href: '/admin/collections/assets', label: 'Media', roles: ['owner', 'editor'] },
  { href: '/leads', label: 'Leads', roles: ['owner', 'sales'] },
  { href: '/applications', label: 'Careers', roles: ['owner', 'hiring'] },
  { href: '/editorial', label: 'Reviews', roles: ['owner', 'editor', 'approver'] },
  { href: '/operations', label: 'Changelog', roles: ['owner'] },
]

export const adminSiteNavigationItems: readonly AdminNavigationItem[] = [
  { href: '/integrations', label: 'Integrations', roles: ['owner'] },
  { href: '/admin/collections/users', label: 'Users', roles: ['owner'] },
]

/** Related tools remain discoverable without competing with the primary shell. */
export const adminToolNavigationItems: readonly AdminNavigationItem[] = [
  { href: '/direct-edit', label: 'Hero draft editor', roles: ['owner', 'editor'] },
  { href: '/themes', label: 'Themes', roles: ['owner'] },
  { href: '/ai-jobs', label: 'AI jobs', roles: ['owner'] },
]

export const payloadCollectionItems: readonly AdminNavigationItem[] = [
  { href: '/admin/collections/pages', label: 'Pages', roles: ['owner', 'editor', 'approver'] },
  { href: '/admin/collections/sections', label: 'Sections', roles: ['owner', 'editor', 'approver'] },
  { href: '/admin/collections/assets', label: 'Media', roles: ['owner', 'editor'] },
  { href: '/admin/collections/redirects', label: 'Redirects', roles: ['owner', 'editor', 'approver'] },
  { href: '/admin/collections/audit-events', label: 'Audit events', roles: ['owner'] },
  { href: '/admin/collections/users', label: 'Users', roles: ['owner'] },
]

export function navigationForRoles(roles: readonly string[] | null | undefined, items = adminNavigationItems): AdminNavigationItem[] {
  const actorRoles = new Set(roles)
  return items.filter((item) => item.roles.some((role) => actorRoles.has(role)))
}
