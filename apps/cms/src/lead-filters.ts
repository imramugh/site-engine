import { leadStages } from './inquiries'

export const receivedRanges = ['all', '7', '30', '90', '365'] as const
export type ReceivedRange = typeof receivedRanges[number]

export class LeadFilterError extends Error {}

export type LeadFilters = {
  stage?: string
  urgent: boolean
  assignee?: string
  sourcePage?: string
  received: ReceivedRange
  page: number
}

const sourcePattern = /^\/(?!\/)[a-z0-9/_-]*$/i
const userIDPattern = /^[0-9a-f-]{36}$/i

export function parseLeadFilters(url: URL): LeadFilters {
  const stage = url.searchParams.get('stage') || undefined
  const urgent = url.searchParams.get('urgent')
  const assignee = url.searchParams.get('assignee') || undefined
  const sourcePage = url.searchParams.get('sourcePage') || undefined
  const received = (url.searchParams.get('received') || 'all') as ReceivedRange
  const rawPage = url.searchParams.get('page') || '1'
  const page = Number(rawPage)

  if (stage && !leadStages.includes(stage as never)) throw new LeadFilterError('Choose a valid lead stage.')
  if (urgent && urgent !== 'true' && urgent !== 'false') throw new LeadFilterError('Urgent must be true or false.')
  if (assignee && !userIDPattern.test(assignee)) throw new LeadFilterError('Choose a valid assignee.')
  if (sourcePage && (sourcePage.length > 240 || !sourcePattern.test(sourcePage))) throw new LeadFilterError('Choose a valid source page.')
  if (!receivedRanges.includes(received)) throw new LeadFilterError('Choose all time or leads received in the last 7, 30, 90, or 365 days.')
  if (!Number.isInteger(page) || page < 1) throw new LeadFilterError('Page must be a positive whole number.')

  return { stage, urgent: urgent === 'true', assignee, sourcePage, received, page }
}

export function leadFilterClauses(filters: LeadFilters, includeStage: boolean, now = new Date()): Record<string, unknown>[] {
  const clauses: Record<string, unknown>[] = []
  if (includeStage && filters.stage) clauses.push({ stage: { equals: filters.stage } })
  if (filters.urgent) clauses.push({ urgent: { equals: true } })
  if (filters.assignee) clauses.push({ assignee: { equals: filters.assignee } })
  if (filters.sourcePage) clauses.push({ sourcePage: { equals: filters.sourcePage } })
  if (filters.received !== 'all') clauses.push({ createdAt: { greater_than_equal: new Date(now.getTime() - Number(filters.received) * 86_400_000).toISOString() } })
  return clauses
}

export function leadWhere(filters: LeadFilters, includeStage: boolean, now = new Date()) {
  const clauses = leadFilterClauses(filters, includeStage, now)
  return clauses.length ? { and: clauses } as never : undefined
}
