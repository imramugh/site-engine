import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { withPayloadTransaction } from '../../../../src/auth-transaction'
import { loadInitialPreviewBaseline, prepareReviewPreview } from '../../../../src/review-preview'
import { serverSessionStrategy } from '../../../../src/identity'
import { changeSetHash } from '../../../../src/publishing'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }
function sameOrigin(request: Request) { const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; const origin = request.headers.get('origin'); return Boolean(configured && origin === new URL(configured).origin) }
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  try {
    const body = await request.json() as { id?: string; includedChangeKeys?: string[] }
    if (!body.id || !Array.isArray(body.includedChangeKeys)) throw new Error('Review proof is incomplete.')
    // File IO and JSON validation happen before the SQLite transaction.
    const initialBaseline = await loadInitialPreviewBaseline()
    const payload = await getPayload({ config }); const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    if (!authenticated.user) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
    const actor = authenticated.user as { id: string; roles?: string[] }
    // Capture the reviewed proof on the same SQLite connection as preparation.
    // An out-of-transaction local read can retain a connection while the
    // immediate write transaction waits for it under the browser workload.
    const job = await withPayloadTransaction(payload, async req => {
      const current = await payload.findByID({ collection: 'change-sets', id: body.id!, depth: 0, overrideAccess: true, req })
      const changes = Array.isArray(current.changes) ? current.changes : []
      return prepareReviewPreview({ payload, req, actor, id: body.id!, expectedRevision: Number(current.revision), expectedChangeHash: changeSetHash(changes), includedChangeKeys: body.includedChangeKeys!, initialBaseline })
    })
    return Response.json({ job }, { headers: noStore })
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Unable to prepare review preview.' }, { status: 400, headers: noStore }) }
}
