import { sqliteAuthenticationBoundary } from '../../../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { freshStaff, hasRole } from '../../../../../src/access'
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

async function currentBaseline(payload: Awaited<ReturnType<typeof getPayload>>) {
  const queued = await payload.find({ collection: 'publish-outbox', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true })
  if (queued.docs[0]) return { snapshotID: relationID(queued.docs[0].snapshot), sequence: Number(queued.docs[0].sequence) }
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
    try { review = await loadReviewModeData(payload, id, { pageID }) }
    catch (error) {
      // Failed diagnostics are a narrow, current-review presentation. Never
      // turn a database/auth failure or any unrelated review load error into
      // a diagnostic response.
      if (isAuthenticationSQLiteContention(error) || !(error instanceof Error) || !/ready comparison|comparison is no longer current/i.test(error.message)) throw error
      const set = await payload.findByID({ collection: 'change-sets', id, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
      const preview = set.preview as Record<string, unknown> | undefined
      const jobID = preview?.jobID
      if (typeof jobID !== 'string' || preview?.status === 'ready') throw error
      const job = await payload.findByID({ collection: 'preview-render-jobs', id: jobID, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
      const baseline = await currentBaseline(payload)
      const diagnostics = Array.isArray(job.renderDiagnostics) ? job.renderDiagnostics : []
      if (job.status !== 'failed' || relationID(job.changeSet) !== id || Number(preview?.revision) !== Number(set.revision) || Number(job.reviewRevision) !== Number(set.revision) || preview?.changeHash !== job.changeHash || job.changeHash !== (await import('../../../../../src/publishing')).changeSetHash(Array.isArray(set.changes) ? set.changes as never[] : []) || !keysMatch(preview?.includedChangeKeys, job.includedChangeKeys) || preview?.baselineSnapshotID !== relationID(job.baselineSnapshot) || Number(preview?.baselineSequence) !== Number(job.baselineSequence) || baseline && (relationID(job.baselineSnapshot) !== baseline.snapshotID || Number(job.baselineSequence) !== baseline.sequence) || preview?.liveManifestHash !== job.liveManifestHash || preview?.proposedManifestHash !== job.proposedManifestHash || canonicalHash(job.liveManifest) !== job.liveManifestHash || canonicalHash(job.proposedManifest) !== job.proposedManifestHash || !versionPinsMatch(preview?.versionPins, job.versionPins)) throw error
      failedPreview = { id: String(set.id), name: String(set.name), state: String(set.state), revision: Number(set.revision), diagnostics }
    }
    const fresh = await freshStaff(['owner', 'approver'])({ req: { payload, user, headers: request.headers } as never })
    return Response.json(failedPreview ? { failedPreview, fresh } : { review, fresh }, { headers: privateHeaders })
  } catch (error) {
    if (isAuthenticationSQLiteContention(error)) throw error
    const text = error instanceof Error ? error.message : 'Unable to load this review.'
    const status = /no longer current|ready comparison/i.test(text) ? 409 : /not found/i.test(text) ? 404 : 400
    return Response.json({ error: text }, { status, headers: privateHeaders })
  }
}

export const GET = sqliteAuthenticationBoundary(GETHandler)
