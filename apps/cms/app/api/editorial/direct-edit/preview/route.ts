import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { withPayloadTransaction } from '../../../../../src/auth-transaction'
import { loadInitialPreviewBaseline, prepareReviewPreview } from '../../../../../src/review-preview'
import { serverSessionStrategy } from '../../../../../src/identity'
import { changeSetHash } from '../../../../../src/publishing'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../../../src/sqlite'
import { SiteSnapshotSchema } from '@site-engine/contract'
import { deriveRoutes } from '@site-engine/engine'

const noStore = { 'Cache-Control': 'no-store' }
const maxBodyBytes = 4_096
async function boundedBody(request: Request): Promise<Record<string, unknown>> { const reader = request.body?.getReader(); if (!reader) throw new Error('INVALID_BODY'); const chunks: Uint8Array[] = []; let size = 0; while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > maxBodyBytes) { await reader.cancel(); throw new Error('BODY_TOO_LARGE') }; chunks.push(chunk.value) }; const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }; return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> }

function previewPath(manifest: unknown, pageID: string): string | undefined {
  const snapshot = SiteSnapshotSchema.parse(manifest)
  return deriveRoutes(snapshot).routes.find((route) => route.page.id === pageID)?.path
}

const sameOrigin = (request: Request) => { const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; return Boolean(configured && request.headers.get('origin') === new URL(configured).origin) }
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  try {
    const body = await boundedBody(request) as { changeSetID?: string }
    if (!body.changeSetID || !/^[0-9a-f-]{36}$/i.test(body.changeSetID)) throw new Error('Draft change set is required.')
    const initialBaseline = await loadInitialPreviewBaseline(); const payload = await getPayload({ config }); const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); const actor = authenticated.user as { id?: string; roles?: string[] } | null
    if (!actor?.id) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
    const job = await withPayloadTransaction(payload, async req => { const set = await payload.findByID({ collection: 'change-sets', id: body.changeSetID!, depth: 0, overrideAccess: true, req }); const changes = Array.isArray(set.changes) ? set.changes : []; return prepareReviewPreview({ payload, req, actor: actor as { id: string; roles?: string[] }, id: body.changeSetID!, expectedRevision: Number(set.revision), expectedChangeHash: changeSetHash(changes), includedChangeKeys: changes.map((change: any) => `${change.collection}:${change.id}`), initialBaseline, draft: true }) })
    return Response.json({ job: { id: job.id, status: job.status } }, { headers: noStore })
  } catch (error) { return sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, noStore) ?? Response.json({ error: 'The draft preview could not be prepared.' }, { status: error instanceof Error && error.message === 'BODY_TOO_LARGE' ? 413 : 400, headers: noStore }) }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url); const jobID = url.searchParams.get('jobID'); const pageID = url.searchParams.get('pageID')
    if (!jobID || !pageID || !/^[0-9a-f-]{36}$/i.test(jobID) || !/^[0-9a-f-]{36}$/i.test(pageID)) return Response.json({ error: 'Preview job is required.' }, { status: 400, headers: noStore })
    const payload = await getPayload({ config }); const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); const actor = authenticated.user as { id?: string; roles?: string[] } | null
    if (!actor?.id) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
    if (!actor.roles?.some((role) => role === 'owner' || role === 'editor' || role === 'approver')) return Response.json({ error: 'Page editor access required.' }, { status: 403, headers: noStore })
    const job = await payload.findByID({ collection: 'preview-render-jobs', id: jobID, depth: 0, overrideAccess: true })
    const set = await payload.findByID({ collection: 'change-sets', id: String(job.changeSet), depth: 0, overrideAccess: true })
    if (!['open', 'changes-requested'].includes(String(set.state)) || Number(set.revision) !== Number(job.reviewRevision) || changeSetHash(Array.isArray(set.changes) ? set.changes : []) !== String(job.changeHash) || (!actor.roles?.includes('owner') && String(typeof set.actor === 'string' ? set.actor : set.actor?.id) !== actor.id)) return Response.json({ error: 'Preview unavailable.' }, { status: 403, headers: noStore })
    const path = previewPath(job.proposedManifest, pageID); if (!path) return Response.json({ error: 'Preview page is unavailable.' }, { status: 403, headers: noStore })
    return Response.json({ job: { id: job.id, status: job.status, path } }, { headers: noStore })
  } catch { return Response.json({ error: 'Preview unavailable.' }, { status: 404, headers: noStore }) }
}
