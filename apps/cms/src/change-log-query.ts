import type { Payload, Where } from 'payload'

const categoryPrefixes: Record<string, string[]> = {
  editorial: ['editorial.'], identity: ['identity.'], integration: ['integration.'],
  assistant: ['mcp.', 'ai.'], media: ['media.', 'block_gallery.'],
  lead: ['lead.', 'inquiry.'], career: ['application.'], site: ['site.', 'theme.'],
}
const assistant = () => ({ or: categoryPrefixes.assistant!.map(prefix => ({ event: { like: `${prefix}%` } })) })

/** Match the same categories and sources that the change-log projection displays. */
export async function changeLogFilters(payload: Payload, query: { type?: string; source?: string; target?: string }): Promise<Where[]> {
  const clauses: Where[] = []
  const prefixes = query.type ? categoryPrefixes[query.type] : undefined
  if (prefixes) clauses.push({ or: prefixes.map(prefix => ({ event: { like: `${prefix}%` } })) })
  if (query.source === 'assistant') clauses.push(assistant())
  if (query.source === 'person' || query.source === 'system') {
    clauses.push({ actor: { exists: query.source === 'person' } })
    for (const prefix of categoryPrefixes.assistant!) clauses.push({ event: { not_like: `${prefix}%` } })
  }
  if (query.target) {
    // Captured changes are JSON. Scan selected fields in bounded database pages
    // so approvals are found through their change set as well as direct events.
    const ids: string[] = []
    let page = 1
    while (true) {
      const result = await payload.find({ collection: 'change-sets', page, limit: 100, depth: 0, overrideAccess: true, select: { changes: true } })
      for (const set of result.docs) if (Array.isArray(set.changes) && set.changes.some(change => change && typeof change === 'object' && 'collection' in change && change.collection === 'pages' && 'id' in change && change.id === query.target)) ids.push(String(set.id))
      if (!result.hasNextPage) break
      page++
    }
    clauses.push({ or: [
      { 'detail.page': { equals: query.target } }, { 'detail.id': { equals: query.target } },
      { 'detail.target': { equals: query.target } },
      ...(ids.length ? [{ 'detail.changeSet': { in: ids } }] : []),
    ] })
  }
  return clauses
}
