import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { withPayloadTransaction } from '../../../../../src/auth-transaction'
import { boundedPublishWorkerJSON, claimNextPublishJob, completePublishJob, publishWorkerAuthorized, recordPublishStage, renewPublishLease, retryPublishJob, type VerifiedArtifact } from '../../../../../src/publishing'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../../../src/sqlite'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }
const relationID = (value: unknown): string | undefined => typeof value === 'string' ? value : value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? value.id : undefined

export async function POST(request: Request, context: { params: Promise<{ action: string }> }): Promise<Response> {
  if (!publishWorkerAuthorized(request)) return Response.json({ error: 'Unauthorized.' }, { status: 401, headers: noStore })
  try {
    const payload = await getPayload({ config }); const { action } = await context.params; const body = await boundedPublishWorkerJSON(request)
    const result = await withPayloadTransaction(payload, async (req) => {
      if (action === 'claim') {
        const job = await claimNextPublishJob(payload, req)
        if (!job) return null
        return payload.findByID({ collection: 'publish-outbox', id: job.id, depth: 1, overrideAccess: true, req })
      }
      if (typeof body.id !== 'string' || typeof body.leaseToken !== 'string') throw new Error('Job ID and lease token are required.')
      if (action === 'log') return recordPublishStage(payload, req, body.id, body.leaseToken, String(body.stage))
      if (action === 'renew') return renewPublishLease(payload, req, body.id, body.leaseToken)
      if (action === 'fail') return retryPublishJob(payload, req, body.id, body.leaseToken, String(body.errorCode))
      if (action === 'complete') return completePublishJob(payload, req, body.id, body.leaseToken, body.artifact as VerifiedArtifact)
      throw new Error('Unknown worker action.')
    })
    if (action !== 'claim') return Response.json({ job: result }, { headers: noStore })
    if (!result) return Response.json({ job: null }, { headers: noStore })
    const claimed = result as { id: string; leaseToken: string; leaseExpiresAt: string; sequence: number; correlationID: string; changeSet: unknown; reviewRevision: number; includedChangeKeys: unknown; snapshot: unknown }
    const snapshot = claimed.snapshot as Record<string, unknown> & { id?: string; approvedBy?: unknown; createdAt?: string }
    const approvedBy = relationID(snapshot.approvedBy)
    const changeSetID = relationID(claimed.changeSet)
    return Response.json({ job: { id: claimed.id, leaseToken: claimed.leaseToken, leaseExpiresAt: claimed.leaseExpiresAt, sequence: claimed.sequence, correlationID: claimed.correlationID }, snapshot: snapshot.manifest, contentHash: snapshot.contentHash, versionPins: { themeVersion: snapshot.themeVersion, engineVersion: snapshot.engineVersion, contractVersion: snapshot.contractVersion }, immutableContext: { changeSetID, approvedRevision: claimed.reviewRevision, includedChangeKeys: claimed.includedChangeKeys, snapshotID: snapshot.id, approvedBy, approvedAt: snapshot.createdAt } }, { headers: noStore })
  } catch (error) { return sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, noStore) ?? Response.json({ error: error instanceof Error ? error.message : 'Worker request failed.' }, { status: 400, headers: noStore }) }
}
