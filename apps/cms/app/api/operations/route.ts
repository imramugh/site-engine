import { getPayload } from 'payload'
import config from '../../../payload.config'
import { hasRole } from '../../../src/access'
import { serverSessionStrategy } from '../../../src/identity'

export const dynamic = 'force-dynamic'

const privateKeys = /(?:email|message|note|resume|coverletter|telephone|token|secret|password)/i
const privateEvents = /(?:application|inquiry|lead)/i

function safeDetail(event: string, detail: unknown): Record<string, unknown> | undefined {
  if (privateEvents.test(event) || !detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined

  return Object.fromEntries(Object.entries(detail as Record<string, unknown>).flatMap(([key, value]) => {
    if (privateKeys.test(key)) return []
    if (value && typeof value === 'object') return [[key, safeDetail('', value)]]
    return [[key, typeof value === 'string' ? value.slice(0, 500) : value]]
  }))
}

function pageOf(value: string | null): number {
  const parsed = Number(value ?? '1')
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1
}

export async function GET(request: Request) {
  const payload = await getPayload({ config })
  const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  const user = auth.user as { roles?: ('owner')[]; disabled?: boolean } | null
  if (!user || !hasRole(user, ['owner'])) return Response.json({ error: 'Owner access required.' }, { status: 403 })

  const url = new URL(request.url)
  const page = pageOf(url.searchParams.get('page'))
  const event = url.searchParams.get('event')?.trim()
  const actor = url.searchParams.get('actor')?.trim()
  const since = url.searchParams.get('since')
  const clauses: Record<string, unknown>[] = []
  if (event) clauses.push({ event: { contains: event.slice(0, 120) } })
  if (actor) {
    const matches = await payload.find({ collection: 'users', where: { or: [{ id: { equals: actor } }, { email: { equals: actor } }] }, limit: 1, depth: 0, overrideAccess: true })
    clauses.push({ actor: { equals: matches.docs[0]?.id ?? actor } })
  }
  if (since && !Number.isNaN(Date.parse(since))) clauses.push({ createdAt: { greater_than_equal: since } })

  const [reviews, leads, releases, pending, processing, failed, latestFailure, audit] = await Promise.all([
    payload.count({ collection: 'change-sets', where: { state: { equals: 'submitted' } }, overrideAccess: true }),
    payload.count({ collection: 'inquiries', where: { or: [{ urgent: { equals: true } }, { stage: { equals: 'new' } }] }, overrideAccess: true }),
    payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, overrideAccess: true }),
    payload.count({ collection: 'publish-outbox', where: { status: { equals: 'pending' } }, overrideAccess: true }),
    payload.count({ collection: 'publish-outbox', where: { status: { equals: 'processing' } }, overrideAccess: true }),
    payload.count({ collection: 'publish-outbox', where: { status: { equals: 'failed' } }, overrideAccess: true }),
    payload.find({ collection: 'publish-outbox', where: { status: { equals: 'failed' } }, sort: '-sequence', limit: 1, overrideAccess: true }),
    payload.find({ collection: 'audit-events', where: clauses.length ? { and: clauses } as never : undefined, sort: '-createdAt', limit: 25, page, depth: 1, overrideAccess: true }),
  ])

  return Response.json({
    summary: {
      pendingReviews: reviews.totalDocs,
      urgentOrNewLeads: leads.totalDocs,
      latestRelease: releases.docs[0] ? { sequence: releases.docs[0].sequence, activatedAt: releases.docs[0].activatedAt } : null,
      latestPublishFailure: latestFailure.docs[0] ? { sequence: latestFailure.docs[0].sequence, errorCode: latestFailure.docs[0].errorCode } : null,
      queue: {
        pending: pending.totalDocs,
        processing: processing.totalDocs,
        failed: failed.totalDocs,
      },
    },
    audit: {
      docs: audit.docs.map((item) => ({
        id: item.id,
        event: item.event,
        actor: typeof item.actor === 'object' ? item.actor?.email : item.actor,
        actorId: typeof item.actor === 'object' ? item.actor?.id : item.actor,
        createdAt: item.createdAt,
        detail: safeDetail(item.event, item.detail),
      })),
      page: audit.page,
      totalPages: audit.totalPages,
    },
    shortcuts: [
      { label: 'Editorial review', href: '/admin/editorial' },
      { label: 'Leads', href: '/leads' },
      { label: 'Applications', href: '/applications' },
    ],
  }, { headers: { 'Cache-Control': 'no-store' } })
}
