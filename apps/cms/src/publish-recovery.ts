import type { Payload, PayloadRequest } from 'payload'
import { hasRole, type Role } from './access'
import { withPayloadTransaction } from './auth-transaction'
import { cookieName, hasFreshAuthentication, hashOpaqueToken, readCookie, SESSION_COOKIE, sessionIsUsable } from './identity'
import { canonicalHash } from './publishing'

type Actor = { id: string; roles?: Role[] | null; disabled?: boolean | null }
type RecordValue = Record<string, unknown>

const relationID = (value: unknown): string | undefined => typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const sameKeys = (left: unknown, right: unknown) => Array.isArray(left) && Array.isArray(right) && left.every((key) => typeof key === 'string') && right.every((key) => typeof key === 'string') && left.length === right.length && new Set(left).size === left.length && [...left].sort().every((key, index) => key === [...right].sort()[index])

function requireTransaction(req: PayloadRequest) {
  if (!req.transactionID) throw new Error('Publish recovery must run inside a database transaction.')
}

async function canonicalReviewer(payload: Payload, req: PayloadRequest, actor: Actor | undefined): Promise<Actor> {
  if (!actor?.id) throw new Error('Fresh Owner or Approver authentication is required.')
  const user = await payload.findByID({ collection: 'users', id: actor.id, depth: 0, overrideAccess: true, req }) as unknown as Actor
  if (!hasRole(user, ['owner', 'approver'])) throw new Error('Fresh Owner or Approver authentication is required.')
  const token = readCookie(req.headers, cookieName(SESSION_COOKIE))
  if (!token) throw new Error('Fresh Owner or Approver authentication is required.')
  const sessions = await payload.find({ collection: 'auth-sessions', where: { tokenHash: { equals: hashOpaqueToken(token) } }, limit: 1, depth: 0, overrideAccess: true, req })
  const session = sessions.docs[0]
  if (!session || relationID(session.user) !== actor.id || !sessionIsUsable(session) || !hasFreshAuthentication(session)) throw new Error('Fresh Owner or Approver authentication is required.')
  return user
}

/** Requeue only the current failed immutable approval after a fresh reviewer confirmation. */
export async function retryFailedPublish(payload: Payload, req: PayloadRequest, actor: Actor | undefined, publishJobID: string, now = new Date()) {
  requireTransaction(req)
  const reviewer = await canonicalReviewer(payload, req, actor)
  const newest = (await payload.find({ collection: 'publish-outbox', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true, req })).docs[0] as unknown as RecordValue | undefined
  const job = newest && String(newest.id) === publishJobID ? newest : undefined
  if (!job) throw new Error('Only the latest publish job can be retried.')
  if (job.status !== 'failed') throw new Error('Only a failed publish job can be retried.')

  const snapshot = record(job.snapshot)
  const changeSet = record(job.changeSet)
  const snapshotID = relationID(snapshot)
  const changeSetID = relationID(changeSet)
  const includedChangeKeys = job.includedChangeKeys
  const capturedKeys = Array.isArray(changeSet.changes) ? changeSet.changes.map((change) => change && typeof change === 'object' ? `${String((change as RecordValue).collection)}:${String((change as RecordValue).id)}` : '') : []
  const proof = record(record(changeSet.quality).proof)
  if (!snapshotID || !changeSetID || !Array.isArray(includedChangeKeys) || includedChangeKeys.length === 0 || String(changeSet.state) !== 'approved' || Number(changeSet.revision) !== Number(job.reviewRevision) || relationID(snapshot.changeSet) !== changeSetID || Number(snapshot.reviewRevision) !== Number(job.reviewRevision) || String(snapshot.changeHash) !== String(job.changeHash) || !relationID(snapshot.approvedBy) || !sameKeys(includedChangeKeys, capturedKeys) || !sameKeys(includedChangeKeys, proof.includedChangeKeys) || Number(proof.revision) !== Number(job.reviewRevision) || String(proof.changeHash) !== String(job.changeHash) || String(proof.contentHash) !== String(snapshot.contentHash) || canonicalHash(snapshot.manifest) !== String(snapshot.contentHash)) throw new Error('The approved immutable publish context is no longer valid.')

  const latestRelease = (await payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 0, overrideAccess: true, req })).docs[0]
  if (latestRelease && Number(latestRelease.sequence) >= Number(job.sequence)) throw new Error('A later release prevents retrying this publish job.')

  const nextAttemptAt = now.toISOString()
  const priorAttempts = Number(job.attempts ?? 0)
  const updated = await payload.update({ collection: 'publish-outbox', where: { and: [{ id: { equals: publishJobID } }, { status: { equals: 'failed' } }] }, data: { status: 'pending', attempts: 0, nextAttemptAt, leaseToken: null, leaseExpiresAt: null, errorCode: null, lastError: null }, overrideAccess: true, req, context: { editorialInternal: true } })
  const retry = updated.docs[0]
  if (!retry) throw new Error('The publish job is no longer eligible for retry.')
  await payload.create({ collection: 'audit-events', data: { event: 'editorial.publish_retry_requested', user: reviewer.id, actor: reviewer.id, detail: { publishJob: publishJobID, changeSet: changeSetID, snapshot: snapshotID, sequence: Number(job.sequence), reviewer: reviewer.id, context: 'fresh_staff_recovery', priorAttempts, nextAttemptAt } }, overrideAccess: true, req })
  return retry
}

export async function requestPublishRetry(payload: Payload, actor: Actor | undefined, headers: Headers, publishJobID: string) {
  return withPayloadTransaction(payload, async (req) => {
    req.user = actor as never
    req.headers = headers
    return retryFailedPublish(payload, req, actor, publishJobID)
  })
}
