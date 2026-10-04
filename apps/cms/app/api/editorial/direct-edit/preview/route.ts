import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { withPayloadTransaction } from '../../../../../src/auth-transaction'
import { loadInitialPreviewBaseline, prepareReviewPreview } from '../../../../../src/review-preview'
import { serverSessionStrategy } from '../../../../../src/identity'
import { changeSetHash } from '../../../../../src/publishing'

const noStore = { 'Cache-Control': 'no-store' }
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
