import type { Payload } from 'payload'
import { activeLeadWhere } from './lead-filters'
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
  { href: '/media', label: 'Media', roles: ['owner', 'editor'] },
  { href: '/leads', label: 'Leads', roles: ['owner', 'sales'] },
  { href: '/applications', label: 'Careers', roles: ['owner', 'hiring'] },
  { href: '/editorial', label: 'Reviews', roles: ['owner', 'editor', 'approver'] },
  { href: '/operations', label: 'Change log', roles: ['owner'] },
  { href: '/retention', label: 'Retention', roles: ['owner'] },
]

export const adminSiteNavigationItems: readonly AdminNavigationItem[] = [
  { href: '/site', label: 'Site', roles: ['owner'] },
  { href: '/integrations', label: 'Integrations', roles: ['owner'] },
  { href: '/users', label: 'Users', roles: ['owner'] },
]

export function navigationForRoles(roles: readonly string[] | null | undefined, items = adminNavigationItems): AdminNavigationItem[] {
  const actorRoles = new Set(roles)
  return items.filter((item) => item.roles.some((role) => actorRoles.has(role)))
}

type CountInput = Parameters<Payload['count']>[0]

export type AdminNavigationBadges = Partial<Record<'Leads' | 'Careers' | 'Reviews', number>>

/** Aggregate-only, role-filtered counts for sidebar badges. Failed queries omit a badge. */
export async function navigationBadges(payload: Pick<Payload, 'count'>, user: { id?: string | number | null; roles?: readonly AdminRole[] | null; disabled?: boolean | null }): Promise<AdminNavigationBadges> {
  const allowed = (role: AdminRole) => !user.disabled && Boolean(user.roles?.includes(role))
  const pending: Array<Promise<void>> = []
  const badges: AdminNavigationBadges = {}
  const count = (key: keyof AdminNavigationBadges, input: CountInput) => pending.push(payload.count(input).then(result => { if (result.totalDocs > 0) badges[key] = result.totalDocs }).catch(() => undefined))
  if (allowed('owner') || allowed('sales')) count('Leads', { collection: 'inquiries', where: { and: [activeLeadWhere, { stage: { equals: 'new' } }] }, overrideAccess: false, user })
  if (allowed('owner') || allowed('hiring')) count('Careers', { collection: 'applications', where: { status: { equals: 'new' } }, overrideAccess: false, user })
  if (allowed('owner') || allowed('editor') || allowed('approver')) count('Reviews', { collection: 'change-sets', where: { state: { equals: 'submitted' } }, overrideAccess: false, user })
  await Promise.all(pending)
  return badges
}
