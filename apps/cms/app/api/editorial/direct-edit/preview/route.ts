import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { withPayloadTransaction } from '../../../../../src/auth-transaction'
import { loadInitialPreviewBaseline, prepareReviewPreview } from '../../../../../src/review-preview'
import { serverSessionStrategy } from '../../../../../src/identity'
import { changeSetHash } from '../../../../../src/publishing'
import { SiteSnapshotSchema } from '@site-engine/contract'

const noStore = { 'Cache-Control': 'no-store' }

function previewPath(manifest: unknown, pageID: string): string | undefined {
  const snapshot = SiteSnapshotSchema.parse(manifest); const page = snapshot.pages.find((item) => item.id === pageID)
  if (!page) return undefined; if (page.id === snapshot.settings.homepageId) return '/'
  const section = snapshot.settings.sections.find((item) => item.id === page.sectionId); if (!section) return undefined
  return `/${[section.slug, page.slug].filter(Boolean).join('/')}`
}

const sameOrigin = (request: Request) => { const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; return Boolean(configured && request.headers.get('origin') === new URL(configured).origin) }
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  try {
    const body = await request.json() as { changeSetID?: string }
    if (!body.changeSetID || !/^[0-9a-f-]{36}$/i.test(body.changeSetID)) throw new Error('Draft change set is required.')
    const initialBaseline = await loadInitialPreviewBaseline(); const payload = await getPayload({ config }); const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); const actor = authenticated.user as { id?: string; roles?: string[] } | null
    if (!actor?.id) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
    const job = await withPayloadTransaction(payload, async req => { const set = await payload.findByID({ collection: 'change-sets', id: body.changeSetID!, depth: 0, overrideAccess: true, req }); const changes = Array.isArray(set.changes) ? set.changes : []; return prepareReviewPreview({ payload, req, actor: actor as { id: string; roles?: string[] }, id: body.changeSetID!, expectedRevision: Number(set.revision), expectedChangeHash: changeSetHash(changes), includedChangeKeys: changes.map((change: any) => `${change.collection}:${change.id}`), initialBaseline, draft: true }) })
    return Response.json({ job: { id: job.id, status: job.status } }, { headers: noStore })
  } catch { return Response.json({ error: 'The draft preview could not be prepared.' }, { status: 400, headers: noStore }) }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url); const jobID = url.searchParams.get('jobID'); const pageID = url.searchParams.get('pageID')
    if (!jobID || !pageID || !/^[0-9a-f-]{36}$/i.test(jobID) || !/^[0-9a-f-]{36}$/i.test(pageID)) return Response.json({ error: 'Preview job is required.' }, { status: 400, headers: noStore })
    const payload = await getPayload({ config }); const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); const actor = authenticated.user as { id?: string; roles?: string[] } | null
    if (!actor?.id) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
    if (!actor.roles?.some((role) => role === 'owner' || role === 'editor')) return Response.json({ error: 'Editor access required.' }, { status: 403, headers: noStore })
    const job = await payload.findByID({ collection: 'preview-render-jobs', id: jobID, depth: 0, overrideAccess: true })
    const set = await payload.findByID({ collection: 'change-sets', id: String(job.changeSet), depth: 0, overrideAccess: true })
    if (!['open', 'changes-requested'].includes(String(set.state)) || Number(set.revision) !== Number(job.reviewRevision) || changeSetHash(Array.isArray(set.changes) ? set.changes : []) !== String(job.changeHash) || (!actor.roles?.includes('owner') && String(typeof set.actor === 'string' ? set.actor : set.actor?.id) !== actor.id)) return Response.json({ error: 'Preview unavailable.' }, { status: 403, headers: noStore })
    const path = previewPath(job.proposedManifest, pageID); if (!path) return Response.json({ error: 'Preview page is unavailable.' }, { status: 403, headers: noStore })
    return Response.json({ job: { id: job.id, status: job.status, path } }, { headers: noStore })
  } catch { return Response.json({ error: 'Preview unavailable.' }, { status: 404, headers: noStore }) }
}
