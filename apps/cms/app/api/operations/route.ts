import { getPayload } from 'payload'
import config from '../../../payload.config'
import { changeLogFilters } from '../../../src/change-log-query'
import { hasRole } from '../../../src/access'
import { serverSessionStrategy } from '../../../src/identity'
import { prepareReviewedRollback, projectChangeLog } from '../../../src/change-log'
import { retentionPolicy } from '../../../src/retention'

export const dynamic = 'force-dynamic'

const privateKeys = /(?:email|message|note|resume|coverletter|telephone|token|secret|password)/i
const privateEvents = /(?:application|inquiry|lead)/i
const noStore = { 'Cache-Control': 'no-store' }

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
  const target = url.searchParams.get('target')?.trim()
  const type = url.searchParams.get('type')?.trim()
  const source = url.searchParams.get('source')?.trim()
  const period = url.searchParams.get('period')?.trim()
  const since = url.searchParams.get('since') ?? (period && ['7', '30', '90'].includes(period) ? new Date(Date.now() - Number(period) * 86_400_000).toISOString() : null)
  const clauses: Record<string, unknown>[] = []
  if (event) clauses.push({ event: { contains: event.slice(0, 120) } })
  if (actor) {
    const matches = await payload.find({ collection: 'users', where: { or: [{ id: { equals: actor } }, { email: { equals: actor } }] }, limit: 1, depth: 0, overrideAccess: true })
    clauses.push({ actor: { equals: matches.docs[0]?.id ?? actor } })
  }
  if (since && !Number.isNaN(Date.parse(since))) clauses.push({ createdAt: { greater_than_equal: since } })
  clauses.push(...await changeLogFilters(payload, { type, source, target }))

  const [reviews, leads, releases, pending, processing, failed, latestFailure, audit, users, pages, retention, retentionFailures] = await Promise.all([
    payload.count({ collection: 'change-sets', where: { state: { equals: 'submitted' } }, overrideAccess: true }),
    payload.count({ collection: 'inquiries', where: { or: [{ urgent: { equals: true } }, { stage: { equals: 'new' } }] }, overrideAccess: true }),
    payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, overrideAccess: true }),
    payload.count({ collection: 'publish-outbox', where: { status: { equals: 'pending' } }, overrideAccess: true }),
    payload.count({ collection: 'publish-outbox', where: { status: { equals: 'processing' } }, overrideAccess: true }),
    payload.count({ collection: 'publish-outbox', where: { status: { equals: 'failed' } }, overrideAccess: true }),
    payload.find({ collection: 'publish-outbox', where: { status: { equals: 'failed' } }, sort: '-sequence', limit: 1, overrideAccess: true }),
    payload.find({ collection: 'audit-events', where: clauses.length ? { and: clauses } as never : undefined, sort: '-createdAt', limit: 25, page, depth: 1, overrideAccess: true }),
    payload.find({ collection: 'users', sort: 'name', limit: 200, depth: 0, overrideAccess: true }),
    payload.find({ collection: 'pages', sort: 'title', limit: 200, depth: 0, draft: true, overrideAccess: true }),
    retentionPolicy(payload),
    payload.count({ collection: 'retention-purge-jobs', where: { state: { equals: 'failed' } }, overrideAccess: true }),
  ])

  const projected = await projectChangeLog(payload, audit.docs as unknown as Array<Record<string, unknown>>)
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
    retention: { ...retention, failedJobs: retentionFailures.totalDocs, backupNotice: 'Deletion markers are replayed before a restored backup serves traffic. Immutable backups age out on their configured schedule.' },
    audit: {
      docs: projected.map((item, index) => ({ ...item, actorId: typeof audit.docs[index]?.actor === 'object' ? audit.docs[index]?.actor?.id : audit.docs[index]?.actor, metadata: safeDetail(audit.docs[index]!.event, audit.docs[index]!.detail) })),
      page: audit.page,
      totalPages: audit.totalPages,
    },
    shortcuts: [
      { label: 'Editorial review', href: '/editorial' },
      { label: 'Leads', href: '/leads' },
      { label: 'Applications', href: '/applications' },
    ],
    filterOptions: {
      actors: users.docs.map(user => ({ id: user.id, label: user.name || user.email })),
      pages: pages.docs.map(page => ({ id: page.id, label: page.title })),
    },
  }, { headers: noStore })
}

export async function POST(request: Request) {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  if (!configured || request.headers.get('origin') !== new URL(configured).origin) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  try {
    const text = await request.text()
    if (Buffer.byteLength(text) > 4096) return Response.json({ error: 'The rollback request is too large.' }, { status: 413, headers: noStore })
    const body: unknown = JSON.parse(text)
    if (!body || typeof body !== 'object' || Array.isArray(body) || (body as { action?: unknown }).action !== 'prepare-rollback' || typeof (body as { releaseID?: unknown }).releaseID !== 'string') return Response.json({ error: 'Choose a release to prepare for rollback.' }, { status: 400, headers: noStore })
    const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    const actor = auth.user as { id: string; name?: string; email?: string; roles?: ('owner')[]; disabled?: boolean } | null
    if (!actor || !hasRole(actor, ['owner'])) return Response.json({ error: 'Owner access required.' }, { status: 403, headers: noStore })
    const set = await prepareReviewedRollback(payload, actor, request.headers, (body as { releaseID: string }).releaseID)
    return Response.json({ changeSet: { id: set.id, name: set.name, state: set.state }, reviewURL: '/editorial' }, { status: 201, headers: noStore })
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Rollback preparation failed.' }, { status: 400, headers: noStore }) }
}
