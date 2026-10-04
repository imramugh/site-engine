export type AdminRole = 'owner' | 'editor' | 'approver' | 'sales' | 'hiring'

export type AdminNavigationItem = {
  href: string
  label: string
  roles: readonly AdminRole[]
}

const allStaff: readonly AdminRole[] = ['owner', 'editor', 'approver', 'sales', 'hiring']

/**
 * One role-aware route map for the Payload and staff workspaces. Route handlers
 * remain the authority for direct requests; this only controls discovery.
 */
export const adminNavigationItems: readonly AdminNavigationItem[] = [
  { href: '/admin', label: 'Overview', roles: allStaff },
  { href: '/content-tree', label: 'Content tree', roles: ['owner', 'editor', 'approver'] },
  { href: '/admin/editorial', label: 'Editorial review', roles: ['owner', 'editor', 'approver'] },
  { href: '/block-gallery', label: 'Block gallery', roles: ['owner', 'editor'] },
  { href: '/leads', label: 'Lead pipeline', roles: ['owner', 'sales'] },
  { href: '/applications', label: 'Applications', roles: ['owner', 'hiring'] },
  { href: '/operations', label: 'Operations', roles: ['owner'] },
  { href: '/themes', label: 'Themes', roles: ['owner'] },
  { href: '/integrations', label: 'Integrations', roles: ['owner'] },
  { href: '/ai-jobs', label: 'AI jobs', roles: ['owner'] },
]

export const payloadCollectionItems: readonly AdminNavigationItem[] = [
  { href: '/admin/collections/pages', label: 'Pages', roles: ['owner', 'editor', 'approver'] },
  { href: '/admin/collections/sections', label: 'Sections', roles: ['owner', 'editor', 'approver'] },
  { href: '/admin/collections/assets', label: 'Media', roles: ['owner', 'editor'] },
  { href: '/admin/collections/redirects', label: 'Redirects', roles: ['owner', 'editor', 'approver'] },
]

export function navigationForRoles(roles: readonly string[] | null | undefined, items = adminNavigationItems): AdminNavigationItem[] {
  const actorRoles = new Set(roles)
  return items.filter((item) => item.roles.some((role) => actorRoles.has(role)))
}
