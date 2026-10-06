import { sqliteAuthenticationBoundary } from '../../../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { freshStaff, hasRole } from '../../../../../src/access'
import { serverSessionStrategy } from '../../../../../src/identity'
import { isAuthenticationSQLiteContention } from '../../../../../src/sqlite'
import { loadReviewModeData } from '../../../../../src/review-mode'

export const dynamic = 'force-dynamic'
const privateHeaders = { 'Cache-Control': 'private, no-store' }

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
      const set = await payload.findByID({ collection: 'change-sets', id, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
      const preview = set.preview as Record<string, unknown> | undefined
      const jobID = preview?.jobID
      if (typeof jobID !== 'string' || preview?.status === 'ready') throw error
      const job = await payload.findByID({ collection: 'preview-render-jobs', id: jobID, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
      const diagnostics = Array.isArray(job.renderDiagnostics) ? job.renderDiagnostics : []
      const jobSet = typeof job.changeSet === 'string' ? job.changeSet : job.changeSet && typeof job.changeSet === 'object' ? (job.changeSet as { id?: unknown }).id : undefined
      if (job.status !== 'failed' || jobSet !== id || Number(job.reviewRevision) !== Number(set.revision) || job.changeHash !== (await import('../../../../../src/publishing')).changeSetHash(Array.isArray(set.changes) ? set.changes as never[] : [])) throw error
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
