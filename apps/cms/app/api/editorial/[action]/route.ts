import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { withPayloadTransaction } from '../../../../src/auth-transaction'
import { createNamedChangeSet, transitionChangeSet } from '../../../../src/editorial'
import { archivePage } from '../../../../src/redirect-lifecycle'
import { serverSessionStrategy } from '../../../../src/identity'
import { changeSetHash, scheduledPublicationTime } from '../../../../src/publishing'
import { approveChangeSet } from '../../../../src/publishing'
import { runReviewQuality } from '../../../../src/review-quality'
import { loadInitialPreviewBaseline } from '../../../../src/review-preview'
import { freshStaff } from '../../../../src/access'
import { routeForReviewPreview } from '../../../../src/review-mode'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../../src/sqlite'

export const dynamic = 'force-dynamic'

function sameOrigin(request: Request): boolean {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  return Boolean(configured && origin && origin === new URL(configured).origin)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Editorial workflow request failed.'
}

const relationID = (value: unknown): string | undefined => typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined

function reviewPresentation(set: Record<string, unknown>, names: Map<string, string>, viewerID: string) {
  const actorID = relationID(set.actor)
  const changes = Array.isArray(set.changes) ? set.changes as Array<Record<string, unknown>> : []
  const affectedPageCount = new Set(changes.filter(change => change.collection === 'pages' && typeof change.id === 'string').map(change => change.id as string)).size
  const quality = set.quality && typeof set.quality === 'object' ? set.quality as Record<string, unknown> : undefined
  const checks = Array.isArray(quality?.checks) ? quality.checks as Array<Record<string, unknown>> : []
  const proof = quality?.proof && typeof quality.proof === 'object' ? quality.proof as Record<string, unknown> : undefined
  const report = proof?.report && typeof proof.report === 'object' ? proof.report as Record<string, unknown> : undefined
  const blockers = Array.isArray(report?.blockers) ? report.blockers.length : 0
  const warnings = Array.isArray(report?.warnings) ? report.warnings.length : 0
  const failedChecks = checks.filter(check => check.status !== 'passed').length
  const checkSummary = blockers ? `${blockers} blocking ${blockers === 1 ? 'issue' : 'issues'}` : failedChecks ? `${failedChecks} ${failedChecks === 1 ? 'check needs' : 'checks need'} attention` : report?.publishable === true || checks.length ? 'Checks passed' : 'Checks not run'
  return {
    actorLabel: actorID === viewerID ? 'You' : actorID ? names.get(actorID) ?? 'Former staff account' : 'System',
    sourceLabel: 'Source not recorded',
    occurredAt: typeof set.submittedAt === 'string' ? set.submittedAt : typeof set.updatedAt === 'string' ? set.updatedAt : typeof set.createdAt === 'string' ? set.createdAt : null,
    affectedPageCount,
    checkSummary,
    warningCount: warnings,
  }
}

type ApprovalProof = { revision: number; changeHash: string; contentHash: string; includedChangeKeys: string[]; baselineSnapshotID?: string; baselineSequence: number; previewJobID: string; versionPins: { themeVersion: string; engineVersion: string; contractVersion: string; liveThemeVersion?: string; liveContractVersion?: string } }

function approvalProof(value: unknown): ApprovalProof | undefined {
  if (!value || typeof value !== 'object') return undefined
  const proof = value as Record<string, unknown>
  const pins = proof.versionPins
  if (!Number.isInteger(proof.revision) || typeof proof.changeHash !== 'string' || typeof proof.contentHash !== 'string' || !Array.isArray(proof.includedChangeKeys) || !proof.includedChangeKeys.every((key): key is string => typeof key === 'string') || (proof.baselineSnapshotID !== undefined && typeof proof.baselineSnapshotID !== 'string') || !Number.isInteger(proof.baselineSequence) || typeof proof.previewJobID !== 'string' || !pins || typeof pins !== 'object') return undefined
  const versions = pins as Record<string, unknown>
  if (typeof versions.themeVersion !== 'string' || typeof versions.engineVersion !== 'string' || typeof versions.contractVersion !== 'string') return undefined
  if ((versions.liveThemeVersion !== undefined && typeof versions.liveThemeVersion !== 'string') || (versions.liveContractVersion !== undefined && typeof versions.liveContractVersion !== 'string')) return undefined
  return { revision: proof.revision as number, changeHash: proof.changeHash, contentHash: proof.contentHash, includedChangeKeys: proof.includedChangeKeys, baselineSnapshotID: proof.baselineSnapshotID as string | undefined, baselineSequence: proof.baselineSequence as number, previewJobID: proof.previewJobID, versionPins: { themeVersion: versions.themeVersion, engineVersion: versions.engineVersion, contractVersion: versions.contractVersion, ...(typeof versions.liveThemeVersion === 'string' ? { liveThemeVersion: versions.liveThemeVersion } : {}), ...(typeof versions.liveContractVersion === 'string' ? { liveContractVersion: versions.liveContractVersion } : {}) } }
}

const sameKeys = (left: readonly string[], right: readonly string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())

/** Server-owned lifecycle API. Collection REST updates are denied so clients
 * cannot forge state, actor, baseline, or review timestamps. */
export async function POST(request: Request, context: { params: Promise<{ action: string }> }): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403 })
  try {
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    if (!authenticated.user) return Response.json({ error: 'Authentication required.' }, { status: 401 })
    const body = await request.json() as { id?: string; name?: string; target?: string; removeNavigationReference?: boolean; proof?: unknown; scheduledFor?: unknown }
    const { action } = await context.params
    if (action === 'publish') return Response.json({ error: 'Publication is performed only by the durable worker after approval.' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    const initialBaseline = action === 'approve' ? await loadInitialPreviewBaseline() : undefined
    const result = await withPayloadTransaction(payload, async (req) => {
      req.user = authenticated.user
      req.headers = request.headers
      if (action === 'create') {
        if (typeof body.name !== 'string') throw new Error('A change-set name is required.')
        return createNamedChangeSet(payload, req, authenticated.user as never, body.name)
      }
      if (action === 'comment' && typeof body.id === 'string' && typeof (body as { comment?: unknown }).comment === 'string') {
        const actor = authenticated.user as { id: string; roles?: string[] }
        if (!actor.roles?.some((role) => role === 'owner' || role === 'approver')) throw new Error('Reviewer role required.')
        const comment = (body as { comment: string }).comment.trim()
        if (!comment || comment.length > 2_000) throw new Error('A review comment must contain at most 2,000 characters.')
        const set = await payload.findByID({ collection: 'change-sets', id: body.id, depth: 0, overrideAccess: true, req })
        const comments = Array.isArray(set.reviewComments) ? set.reviewComments : []
        return payload.update({ collection: 'change-sets', id: body.id, data: { reviewComments: [...comments, { id: crypto.randomUUID(), author: actor.id, body: comment, createdAt: new Date().toISOString() }] }, overrideAccess: true, req, context: { editorialInternal: true } })
      }
      if (action === 'archive') {
        if (typeof body.id !== 'string') throw new Error('A page ID is required.')
        if (!(authenticated.user as { roles?: string[] }).roles?.some((role) => role === 'owner' || role === 'editor')) throw new Error('Editor role required.')
        if (body.removeNavigationReference !== undefined && typeof body.removeNavigationReference !== 'boolean') throw new Error('Navigation removal confirmation must be a boolean.')
        return archivePage({ payload, req, pageID: body.id, target: body.target, removeNavigationReference: body.removeNavigationReference })
      }
      if (action === 'run-quality' && typeof body.id === 'string') {
        const actor = authenticated.user as { roles?: string[] }
        if (!actor.roles?.some((role) => role === 'owner' || role === 'approver')) throw new Error('Reviewer role required.')
        return runReviewQuality({ payload, req, id: body.id })
      }
      if (action === 'approve' && typeof body.id === 'string') {
        if (!(await freshStaff(['owner', 'approver'])({ req }))) throw new Error('Fresh reviewer authentication is required before approval.')
        const proof = approvalProof(body.proof)
        if (!proof) throw new Error('The exact readiness proof displayed to the reviewer is required before approval.')
        const set = await payload.findByID({ collection: 'change-sets', id: body.id, depth: 0, overrideAccess: true, req }) as unknown as { revision?: unknown; changes?: unknown; preview?: { contentHash?: unknown; includedChangeKeys?: unknown; jobID?: unknown } }
        const preview = set.preview
        if (!preview || typeof preview.contentHash !== 'string' || !Array.isArray(preview.includedChangeKeys) || !preview.includedChangeKeys.every((key): key is string => typeof key === 'string') || typeof preview.jobID !== 'string') throw new Error('A ready private preview is required before approval.')
        const currentHash = changeSetHash(Array.isArray(set.changes) ? set.changes as never[] : [])
        if (proof.revision !== Number(set.revision) || proof.changeHash !== currentHash || proof.contentHash !== preview.contentHash || !sameKeys(proof.includedChangeKeys, preview.includedChangeKeys) || proof.previewJobID !== preview.jobID) throw new Error('The reviewed readiness proof is stale. Reload the exact comparison and run readiness checks again.')
        const job = await payload.findByID({ collection: 'preview-render-jobs', id: preview.jobID, depth: 0, overrideAccess: true, req }) as unknown as { versionPins?: unknown }
        const pins = job.versionPins as { themeVersion?: unknown; engineVersion?: unknown; contractVersion?: unknown; liveThemeVersion?: unknown; liveContractVersion?: unknown } | undefined
        if (!pins || typeof pins.themeVersion !== 'string' || typeof pins.engineVersion !== 'string' || typeof pins.contractVersion !== 'string') throw new Error('The preview version pins are invalid.')
        const proofLiveTheme = proof.versionPins.liveThemeVersion ?? proof.versionPins.themeVersion
        const proofLiveContract = proof.versionPins.liveContractVersion ?? proof.versionPins.contractVersion
        const jobLiveTheme = typeof pins.liveThemeVersion === 'string' ? pins.liveThemeVersion : pins.themeVersion
        const jobLiveContract = typeof pins.liveContractVersion === 'string' ? pins.liveContractVersion : pins.contractVersion
        if (proof.baselineSnapshotID !== (preview as { baselineSnapshotID?: unknown }).baselineSnapshotID || proof.baselineSequence !== (preview as { baselineSequence?: unknown }).baselineSequence || proof.versionPins.themeVersion !== pins.themeVersion || proof.versionPins.engineVersion !== pins.engineVersion || proof.versionPins.contractVersion !== pins.contractVersion || proofLiveTheme !== jobLiveTheme || proofLiveContract !== jobLiveContract) throw new Error('The reviewed readiness proof is stale. Reload the exact comparison and run readiness checks again.')
        const scheduledFor = scheduledPublicationTime(body.scheduledFor)
        return approveChangeSet({ payload, req, actor: authenticated.user as never, id: body.id, expectedRevision: proof.revision, expectedChangeHash: proof.changeHash, includedChangeKeys: proof.includedChangeKeys, previewContentHash: proof.contentHash, previewJobID: proof.previewJobID, versions: proof.versionPins, initialBaseline: initialBaseline?.manifest, scheduledFor })
      }
      if (!['submit', 'request-changes', 'reject', 'discard', 'refresh'].includes(action) || typeof body.id !== 'string') throw new Error('Unknown workflow action or missing change-set ID.')
      return transitionChangeSet({ payload, req, actor: authenticated.user as never, id: body.id, action: action as 'submit' | 'request-changes' | 'reject' | 'discard' | 'refresh' })
    })
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const backpressure = sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, { 'Cache-Control': 'no-store' })
    if (backpressure) return backpressure
    const text = message(error)
    const status = /Authentication|required|role|required|Only the editor/i.test(text) ? 403 : 400
    return Response.json({ error: text }, { status })
  }
}

export async function GET(request: Request, context: { params: Promise<{ action: string }> }): Promise<Response> {
  const { action } = await context.params
  if (!['list', 'preview-route'].includes(action)) return Response.json({ error: 'Unknown editorial resource.' }, { status: 404 })
  try {
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    if (!authenticated.user) return Response.json({ error: 'Authentication required.' }, { status: 401 })
    const actor = authenticated.user as { id: string; roles?: string[] }
    if (action === 'preview-route') {
      if (!actor.roles?.some((role) => role === 'owner' || role === 'approver')) return Response.json({ error: 'Reviewer role required.' }, { status: 403 })
      const id = new URL(request.url).searchParams.get('jobID')
      if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: 'Preview job is required.' }, { status: 400 })
      const job = await payload.findByID({ collection: 'preview-render-jobs', id, depth: 0, overrideAccess: true })
      const set = await payload.findByID({ collection: 'change-sets', id: String(job.changeSet), depth: 0, overrideAccess: true })
      const preview = set.preview as { status?: string; jobID?: string; revision?: number; changeHash?: string } | undefined
      if (job.status !== 'completed' || preview?.status !== 'ready' || preview.jobID !== job.id || preview.revision !== job.reviewRevision || preview.changeHash !== job.changeHash || Number(set.revision) !== job.reviewRevision || changeSetHash(Array.isArray(set.changes) ? set.changes as never[] : []) !== job.changeHash) return Response.json({ error: 'Preview is not current.' }, { status: 403 })
      return Response.json({ path: routeForReviewPreview(job.proposedManifest, job.includedChangeKeys).path }, { headers: { 'Cache-Control': 'no-store' } })
    }
    const result = await payload.find({ collection: 'change-sets', limit: 100, depth: 0, user: authenticated.user, overrideAccess: false })
    const actorIDs = [...new Set(result.docs.map(set => relationID(set.actor)).filter((id): id is string => Boolean(id)))]
    const users = actorIDs.length ? await payload.find({ collection: 'users', where: { id: { in: actorIDs } }, limit: actorIDs.length, depth: 0, overrideAccess: true }) : { docs: [] }
    const names = new Map(users.docs.flatMap(user => typeof user.name === 'string' && user.name.trim() ? [[String(user.id), user.name.trim()] as const] : []))
    const sets = result.docs.map(raw => {
      const set = raw as unknown as Record<string, unknown>
      return {
        id: set.id, name: set.name, state: set.state, revision: set.revision, actor: relationID(set.actor), changes: set.changes,
        quality: set.quality, preview: set.preview, reviewComments: set.reviewComments, submittedAt: set.submittedAt, reviewedAt: set.reviewedAt,
        staleAt: set.staleAt, summary: set.summary, createdAt: set.createdAt, updatedAt: set.updatedAt,
        presentation: reviewPresentation(set, names, actor.id),
      }
    })
    return Response.json({ sets, actor: { id: actor.id, roles: actor.roles ?? [] } }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return Response.json({ error: 'Unable to load change sets.' }, { status: 403 })
  }
}
