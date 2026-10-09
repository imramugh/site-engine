import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { withPayloadTransaction } from '../../../../../src/auth-transaction'
import { boundedJSON, claimPreviewRenderJob, completePreviewRenderJob, failPreviewRenderJob, renewPreviewRenderLease, workerAuthorized } from '../../../../../src/review-preview'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../../../src/sqlite'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }

/** Internal worker API. Keep this route out of every public-edge allowlist. */
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  if (!workerAuthorized(request)) return Response.json({ error: 'Unauthorized.' }, { status: 401, headers: noStore })
  try {
    const payload = await getPayload({ config }); const { action } = await context.params
    const body = await boundedJSON(request)
    const result = await withPayloadTransaction(payload, async (req) => {
      if (action === 'claim') return claimPreviewRenderJob(payload, req)
      if (typeof body.id !== 'string' || typeof body.leaseToken !== 'string') throw new Error('Job ID and lease token are required.')
      if (action === 'renew') return renewPreviewRenderLease(payload, req, body.id, body.leaseToken)
      if (action === 'complete') return completePreviewRenderJob(payload, req, body.id, body.leaseToken, { liveManifestHash: String(body.liveManifestHash), proposedManifestHash: String(body.proposedManifestHash), artifactDigest: String(body.artifactDigest), evidenceManifest: body.evidenceManifest })
      if (action === 'fail') return failPreviewRenderJob(payload, req, body.id, body.leaseToken, String(body.errorCode), undefined, body.diagnostics)
      throw new Error('Unknown worker action.')
    })
    if (action !== 'claim') return Response.json({ job: result }, { headers: noStore })
    if (!result) return Response.json({ job: null }, { headers: noStore })
    return Response.json({ job: { id: result.id, leaseToken: result.leaseToken, leaseExpiresAt: result.leaseExpiresAt }, live: result.liveManifest, proposed: result.proposedManifest, basePaths: { live: 'live', proposed: 'proposed' }, versionPins: result.versionPins }, { headers: noStore })
  } catch (error) { return sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, noStore) ?? Response.json({ error: error instanceof Error ? error.message : 'Worker request failed.' }, { status: 400, headers: noStore }) }
}
