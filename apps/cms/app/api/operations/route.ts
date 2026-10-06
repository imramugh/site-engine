import { sqliteAuthenticationBoundary } from '../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../payload.config'
import { changeLogFilters } from '../../../src/change-log-query'
import { hasRole } from '../../../src/access'
import { serverSessionStrategy } from '../../../src/identity'
import { prepareReviewedRollback, projectChangeLog } from '../../../src/change-log'
import { retentionPolicy } from '../../../src/retention'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../src/sqlite'

export const dynamic = 'force-dynamic'

const privateKeys = /(?:email|message|note|resume|coverletter|telephone|token|secret|password)/i
const privateEvents = /(?:application|inquiry|lead)/i
const noStore = { 'Cache-Control': 'no-store' }
const relationID = (value: unknown): string | undefined => typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined

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

async function GETHandler(request: Request) {
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
  const publish = url.searchParams.get('publish')?.trim()
  if (publish && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publish)) return Response.json({ error: 'Choose a valid publish job.' }, { status: 400, headers: noStore })
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

  const [reviews, leads, releases, pending, processing, failed, latestFailure, audit, users, pages, retention, retentionFailures, publishHistory, releaseHistory] = await Promise.all([
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
    payload.find({ collection: 'publish-outbox', sort: '-sequence', limit: 100, depth: 0, overrideAccess: true }),
    payload.find({ collection: 'published-releases', sort: '-sequence', limit: 100, depth: 0, overrideAccess: true }),
  ])

  const projected = await projectChangeLog(payload, audit.docs as unknown as Array<Record<string, unknown>>)
  const releasesByOutbox = new Map(releaseHistory.docs.map((release) => [relationID(release.outbox), release]))
  const snapshotIDs = publishHistory.docs.map(job => relationID(job.snapshot)).filter((id): id is string => Boolean(id))
  const snapshots = snapshotIDs.length ? await payload.find({ collection: 'publish-snapshots', where: { id: { in: snapshotIDs } }, limit: 100, depth: 0, overrideAccess: true }) : { docs: [] as Record<string, unknown>[] }
  const snapshotsByID = new Map(snapshots.docs.map(snapshot => [String(snapshot.id), snapshot]))
  const releaseSetIDs = snapshots.docs.map(snapshot => relationID(snapshot.changeSet)).filter((id): id is string => Boolean(id))
  const releaseSets = releaseSetIDs.length ? await payload.find({ collection: 'change-sets', where: { id: { in: releaseSetIDs } }, limit: 100, depth: 0, overrideAccess: true }) : { docs: [] as Record<string, unknown>[] }
  const releaseSetsByID = new Map(releaseSets.docs.map(set => [String(set.id), set]))
  const usersByID = new Map(users.docs.map(user => [String(user.id), user]))
  const stageEvents = await payload.find({ collection: 'audit-events', where: { or: [{ event: { equals: 'editorial.publish_stage' } }, { event: { equals: 'publish.completed' } }, { event: { equals: 'publish.failed' } }] }, sort: '-createdAt', limit: 500, depth: 0, overrideAccess: true })
  const stageByOutbox = new Map<string, Record<string, unknown>>()
  for (const event of stageEvents.docs) { const detail = safeDetail(String(event.event), event.detail); const id = relationID(detail?.publishJob); if (id && !stageByOutbox.has(id)) stageByOutbox.set(id, { ...detail, createdAt: event.createdAt }) }
  const selectedPublish = publish ? await payload.find({ collection: 'publish-outbox', where: { id: { equals: publish } }, limit: 1, depth: 0, overrideAccess: true }) : undefined
  const buildEvents = publish ? await payload.find({ collection: 'audit-events', where: { 'detail.publishJob': { equals: publish } }, sort: 'createdAt', limit: 200, depth: 0, overrideAccess: true }) : undefined
  const releaseLabel = (status: unknown) => status === 'pending' ? 'Queued' : status === 'processing' ? 'Building' : status === 'completed' ? 'Deployed' : status === 'failed' ? 'Failed' : 'Queued'
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
    releaseHistory: publishHistory.docs.map((job) => {
      const release = releasesByOutbox.get(String(job.id))
      const snapshot = snapshotsByID.get(relationID(job.snapshot) ?? '')
      const set = snapshot ? releaseSetsByID.get(relationID(snapshot.changeSet) ?? '') : undefined
      const stage = stageByOutbox.get(String(job.id))
      const reviewer = snapshot ? usersByID.get(relationID(snapshot.approvedBy) ?? '') : undefined
      const actor = set ? usersByID.get(relationID(set.actor) ?? '') : undefined
      const stageReviewer = usersByID.get(relationID(stage?.reviewer) ?? '')
      const stageActor = usersByID.get(relationID(stage?.actor) ?? '')
      return {
        id: String(job.id),
        sequence: Number(job.sequence),
        status: String(job.status),
        state: releaseLabel(job.status),
        attempts: Number(job.attempts ?? 0),
        retryReason: typeof job.errorCode === 'string' ? job.errorCode : null,
        correlationID: String(job.correlationID),
        nextAttemptAt: typeof job.nextAttemptAt === 'string' ? job.nextAttemptAt : null,
        activatedAt: typeof release?.activatedAt === 'string' ? release.activatedAt : null,
        publishedAt: typeof snapshot?.createdAt === 'string' ? snapshot.createdAt : null,
        reviewer: stageReviewer ? (stageReviewer.name || stageReviewer.email) : reviewer ? (reviewer.name || reviewer.email) : null,
        actor: stageActor ? (stageActor.name || stageActor.email) : actor ? (actor.name || actor.email) : null,
        resultAt: typeof stage?.publishTime === 'string' ? stage.publishTime : typeof stage?.createdAt === 'string' ? stage.createdAt : typeof job.completedAt === 'string' ? job.completedAt : null,
        buildLogURL: null,
      }
    }),
    buildLog: publish ? (() => {
      const job = selectedPublish?.docs[0]
      if (!job) return null
      const events = (buildEvents?.docs ?? []).filter(event => ['editorial.publish_stage', 'editorial.publish_retry', 'publish.failed', 'publish.completed'].includes(String(event.event))).map(event => {
        const detail = safeDetail(String(event.event), event.detail) ?? {}
        return { id: String(event.id), event: String(event.event), createdAt: String(event.createdAt), stage: typeof detail.stage === 'string' ? detail.stage : null, result: typeof detail.result === 'string' ? detail.result : null, attempt: typeof detail.attempt === 'number' ? detail.attempt : null, correlationID: typeof detail.correlationID === 'string' ? detail.correlationID : null }
      })
      return { id: String(job.id), sequence: Number(job.sequence), status: String(job.status), attempts: Number(job.attempts ?? 0), events }
    })() : null,
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

async function POSTHandler(request: Request) {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  if (!configured || request.headers.get('origin') !== new URL(configured).origin) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  try {
    const text = await request.text()
    if (Buffer.byteLength(text) > 4096) return Response.json({ error: 'The rollback request is too large.' }, { status: 413, headers: noStore })
    const body: unknown = JSON.parse(text)
    if (!body || typeof body !== 'object' || Array.isArray(body) || (body as { action?: unknown }).action !== 'prepare-rollback' || typeof (body as { releaseID?: unknown }).releaseID !== 'string') return Response.json({ error: 'Choose a release to prepare for rollback.' }, { status: 400, headers: noStore })
    const rollback = body as { releaseID: string; mode?: unknown; changeKeys?: unknown }
    if (rollback.mode !== undefined && rollback.mode !== 'release' && rollback.mode !== 'change') return Response.json({ error: 'Choose a supported rollback scope.' }, { status: 400, headers: noStore })
    if (rollback.changeKeys !== undefined && (!Array.isArray(rollback.changeKeys) || rollback.changeKeys.length > 1 || rollback.changeKeys.some(key => typeof key !== 'string' || key.length > 200))) return Response.json({ error: 'Choose one approved change to roll back.' }, { status: 400, headers: noStore })
    const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    const actor = auth.user as { id: string; name?: string; email?: string; roles?: ('owner')[]; disabled?: boolean } | null
    if (!actor || !hasRole(actor, ['owner'])) return Response.json({ error: 'Owner access required.' }, { status: 403, headers: noStore })
    const set = await prepareReviewedRollback(payload, actor, request.headers, rollback.releaseID, { mode: rollback.mode as 'release' | 'change' | undefined, changeKeys: rollback.changeKeys as string[] | undefined })
    return Response.json({ changeSet: { id: set.id, name: set.name, state: set.state }, reviewURL: '/editorial' }, { status: 201, headers: noStore })
  } catch (error) { return sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, noStore) ?? Response.json({ error: error instanceof Error ? error.message : 'Rollback preparation failed.' }, { status: 400, headers: noStore }) }
}

export const GET = sqliteAuthenticationBoundary(GETHandler)
export const POST = sqliteAuthenticationBoundary(POSTHandler)
