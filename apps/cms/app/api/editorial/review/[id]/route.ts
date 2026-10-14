import { sqliteAuthenticationBoundary } from '../../../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { hasRole, sessionStaff } from '../../../../../src/access'
import { serverSessionStrategy } from '../../../../../src/identity'
import { isAuthenticationSQLiteContention } from '../../../../../src/sqlite'
import { loadReviewModeData } from '../../../../../src/review-mode'
import { canonicalHash } from '../../../../../src/publishing'

export const dynamic = 'force-dynamic'
const privateHeaders = { 'Cache-Control': 'private, no-store' }
const relationID = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined
const keysMatch = (left: unknown, right: unknown) => Array.isArray(left) && Array.isArray(right) && left.every((value): value is string => typeof value === 'string') && right.every((value): value is string => typeof value === 'string') && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
const versionPinsMatch = (preview: unknown, job: unknown) => {
  if (!preview || typeof preview !== 'object' || !job || typeof job !== 'object') return false
  const expected = preview as Record<string, unknown>; const actual = job as Record<string, unknown>
  return ['themeVersion', 'engineVersion', 'contractVersion', 'liveThemeVersion', 'liveContractVersion'].every((field) => expected[field] === actual[field])
}

type ReviewPublication = { status: 'queued' | 'publishing' | 'published' | 'failed'; errorCode?: string }

async function publicationForReview(payload: Awaited<ReturnType<typeof getPayload>>, id: string, revision: number): Promise<ReviewPublication | undefined> {
  const jobs = await payload.find({ collection: 'publish-outbox', where: { and: [{ changeSet: { equals: id } }, { reviewRevision: { equals: revision } }] }, sort: '-sequence', limit: 1, depth: 0, overrideAccess: true })
  const job = jobs.docs[0] as unknown as { id: string; status?: string; errorCode?: string } | undefined
  if (!job) return undefined
  if (job.status === 'completed') return { status: 'published' }
  if (job.status === 'processing') return { status: 'publishing' }
  if (job.status === 'failed') return { status: 'failed', ...(typeof job.errorCode === 'string' ? { errorCode: job.errorCode } : {}) }
  return { status: 'queued' }
}

async function currentBaseline(payload: Awaited<ReturnType<typeof getPayload>>) {
  const queued = await payload.find({ collection: 'publish-outbox', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true })
  if (queued.docs[0]) return { snapshotID: relationID(queued.docs[0].snapshot), sequence: Number(queued.docs[0].sequence) }
  const releases = await payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true })
  return releases.docs[0] ? { snapshotID: relationID(releases.docs[0].snapshot), sequence: Number(releases.docs[0].sequence) } : undefined
}
async function currentLive(payload: Awaited<ReturnType<typeof getPayload>>) {
  const releases = await payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true })
  return releases.docs[0] ? { snapshotID: relationID(releases.docs[0].snapshot), sequence: Number(releases.docs[0].sequence) } : undefined
}

async function GETHandler(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    const user = authenticated.user as { id?: string; roles?: ('owner' | 'approver' | 'editor' | 'sales' | 'hiring')[]; disabled?: boolean } | null
    if (!user) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: privateHeaders })
    if (!hasRole(user, ['owner', 'approver'])) return Response.json({ error: 'Reviewer role required.' }, { status: 403, headers: privateHeaders })
    const { id } = await context.params
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return Response.json({ error: 'A valid change set is required.' }, { status: 400, headers: privateHeaders })
    const pageID = new URL(request.url).searchParams.get('pageID') ?? undefined
    if (pageID && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pageID)) return Response.json({ error: 'A valid review page is required.' }, { status: 400, headers: privateHeaders })
    let review
    let failedPreview
    let terminalReview
    try { review = await loadReviewModeData(payload, id, { pageID }) }
    catch (error) {
      // Failed diagnostics are a narrow, current-review presentation. Never
      // turn a database/auth failure or any unrelated review load error into
      // a diagnostic response.
      if (isAuthenticationSQLiteContention(error) || !(error instanceof Error) || !/ready comparison|comparison is no longer current/i.test(error.message)) throw error
      const set = await payload.findByID({ collection: 'change-sets', id, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
      const preview = set.preview as Record<string, unknown> | undefined
      const jobID = preview?.jobID
      // A submitted review without a completed renderer is a normal client
      // bootstrap state. Keep stale and failed evidence on their strict paths.
      if (set.state === 'submitted' && typeof jobID !== 'string') {
        review = undefined
      } else if (set.state === 'rejected' || set.state === 'changes-requested') {
        terminalReview = { id: String(set.id), name: String(set.name), state: String(set.state) }
      } else {
      if (typeof jobID !== 'string' || preview?.status === 'ready') throw error
      const job = await payload.findByID({ collection: 'preview-render-jobs', id: jobID, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
      if (set.state === 'submitted' && (job.status === 'pending' || job.status === 'processing') && relationID(job.changeSet) === id && Number(job.reviewRevision) === Number(set.revision) && preview?.changeHash === job.changeHash && keysMatch(preview?.includedChangeKeys, job.includedChangeKeys)) {
        review = undefined
      } else {
      const baseline = await currentBaseline(payload)
      const diagnostics = Array.isArray(job.renderDiagnostics) ? job.renderDiagnostics : []
      if (job.status !== 'failed' || relationID(job.changeSet) !== id || Number(preview?.revision) !== Number(set.revision) || Number(job.reviewRevision) !== Number(set.revision) || preview?.changeHash !== job.changeHash || job.changeHash !== (await import('../../../../../src/publishing')).changeSetHash(Array.isArray(set.changes) ? set.changes as never[] : []) || !keysMatch(preview?.includedChangeKeys, job.includedChangeKeys) || preview?.baselineSnapshotID !== relationID(job.baselineSnapshot) || Number(preview?.baselineSequence) !== Number(job.baselineSequence) || baseline && (relationID(job.baselineSnapshot) !== baseline.snapshotID || Number(job.baselineSequence) !== baseline.sequence) || preview?.liveManifestHash !== job.liveManifestHash || preview?.proposedManifestHash !== job.proposedManifestHash || canonicalHash(job.liveManifest) !== job.liveManifestHash || canonicalHash(job.proposedManifest) !== job.proposedManifestHash || !versionPinsMatch(preview?.versionPins, job.versionPins)) throw error
      failedPreview = { id: String(set.id), name: String(set.name), state: String(set.state), revision: Number(set.revision), includedChangeKeys: Array.isArray(preview?.includedChangeKeys) ? preview.includedChangeKeys.filter((key): key is string => typeof key === 'string') : [], diagnostics }
      }
      }
    }
    const set = await payload.findByID({ collection: 'change-sets', id, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const preview = set.preview as Record<string, unknown> | undefined
    const revision = Number(set.revision)
    const baseline = review && set.state === 'submitted' ? await currentBaseline(payload) : undefined
    const live = review && set.state === 'submitted' ? await currentLive(payload) : undefined
    const currentBaselineMatches = !baseline ? preview?.baselineSnapshotID === undefined && Number(preview?.baselineSequence) === 0 : preview?.baselineSnapshotID === baseline.snapshotID && Number(preview?.baselineSequence) === baseline.sequence
    const currentLiveMatches = !live ? preview?.liveSnapshotID === undefined && Number(preview?.liveSequence) === 0 : preview?.liveSnapshotID === live.snapshotID && Number(preview?.liveSequence) === live.sequence
    const staleReview = review && set.state === 'submitted' && (!currentBaselineMatches || !currentLiveMatches) ? {
      id: String(set.id), name: String(set.name), state: 'submitted', revision,
      includedChangeKeys: Array.isArray(preview?.includedChangeKeys) ? preview.includedChangeKeys.filter((key): key is string => typeof key === 'string') : [],
      message: 'The live publication baseline changed after this comparison. Prepare a current comparison before approval.',
    } : undefined
    const publication = await publicationForReview(payload, id, revision)
    const pendingReview = !review && !failedPreview && set.state === 'submitted' ? {
      id: String(set.id), name: String(set.name), state: 'submitted', revision,
      changeKeys: Array.isArray(set.changes) ? (set.changes as Array<{ collection?: unknown; id?: unknown }>).flatMap((change) => typeof change.collection === 'string' && typeof change.id === 'string' ? [`${change.collection}:${change.id}`] : []) : [],
      preview: { status: typeof preview?.status === 'string' ? preview.status : 'pending', ...(typeof preview?.jobID === 'string' ? { jobID: preview.jobID } : {}), ...(Array.isArray(preview?.includedChangeKeys) ? { includedChangeKeys: preview.includedChangeKeys.filter((key): key is string => typeof key === 'string') } : {}) },
    } : undefined
    const sessionAuthorized = await sessionStaff(['owner', 'approver'])({ req: { payload, user, headers: request.headers } as never })
    return Response.json(failedPreview ? { failedPreview, sessionAuthorized, publication } : { review: staleReview ? undefined : review, staleReview, pendingReview, terminalReview, publication, sessionAuthorized }, { headers: privateHeaders })
  } catch (error) {
    if (isAuthenticationSQLiteContention(error)) throw error
    const text = error instanceof Error ? error.message : 'Unable to load this review.'
    const status = /no longer current|ready comparison/i.test(text) ? 409 : /not found/i.test(text) ? 404 : 400
    return Response.json({ error: text }, { status, headers: privateHeaders })
  }
}

export const GET = sqliteAuthenticationBoundary(GETHandler)
