import type { Payload } from 'payload'
import { hasRole, type Role } from './access'

export type AdminSearchResult = { title: string; url: string; category: 'Pages' | 'Media' | 'Leads' }
export type AdminSearchResponse = { results: Record<AdminSearchResult['category'], AdminSearchResult[]> }

const empty = (): AdminSearchResponse => ({ results: { Pages: [], Media: [], Leads: [] } })

export function boundedSearchQuery(value: string | null): string | undefined {
  const query = value?.trim().replace(/\s+/g, ' ')
  return query && query.length >= 2 && query.length <= 80 ? query : undefined
}

export async function searchAdminRecords(payload: Payload, user: { id?: string; roles?: Role[] | null; disabled?: boolean | null }, query: string): Promise<AdminSearchResponse> {
  const response = empty()
  const canEdit = hasRole(user, ['owner', 'editor', 'approver'])
  const canSeeLeads = hasRole(user, ['owner', 'sales'])
  const text = { contains: query }
  if (canEdit) {
    const [pages, assets] = await Promise.all([
      payload.find({ collection: 'pages', where: { or: [{ title: text }, { slug: text }] }, select: { title: true }, limit: 10, depth: 0, overrideAccess: false, user }),
      payload.find({ collection: 'assets', where: { or: [{ alt: text }, { caption: text }, { filename: text }] }, select: { alt: true, filename: true }, limit: 10, depth: 0, overrideAccess: false, user }),
    ])
    response.results.Pages = pages.docs.map((page) => ({ category: 'Pages', title: String(page.title), url: `/admin/collections/pages/${page.id}` }))
    response.results.Media = assets.docs.map((asset) => ({ category: 'Media', title: String(asset.alt || asset.filename || 'Untitled media'), url: `/admin/collections/assets/${asset.id}` }))
  }
  if (canSeeLeads) {
    const leads = await payload.find({ collection: 'inquiries', where: { or: [{ company: text }, { name: text }, { topic: text }] }, select: { company: true, topic: true }, limit: 10, depth: 0, overrideAccess: false, user })
    // Lead contact details and message text never leave this endpoint. A generic
    // title provides a useful route without widening the dashboard data surface.
    response.results.Leads = leads.docs.map((lead) => ({ category: 'Leads', title: String(lead.company || lead.topic || 'Lead'), url: `/admin/collections/inquiries/${encodeURIComponent(String(lead.id))}` }))
  }
  return response
}
