import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Payload, PayloadRequest } from 'payload'
import { SiteSnapshotSchema, type SiteSnapshot } from '@site-engine/contract'
import { buildCandidate, canonicalHash, changeSetHash } from './publishing'

type Versions = { themeVersion: string; engineVersion: string; contractVersion: string }
type Change = { collection: 'pages' | 'sections' | 'redirects'; id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; beforeHash: string | null; afterHash: string | null }
type Baseline = { manifest: SiteSnapshot; snapshotID?: string; sequence: number; versions: Versions }
const MAX_ATTEMPTS = 3
const MAX_BODY_BYTES = 16 * 1024

const idOf = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined
const keysEqual = (left: readonly string[], right: readonly string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
const requireTransaction = (req: PayloadRequest, operation: string) => { if (!req.transactionID) throw new Error(`${operation} must run inside a database transaction.`) }

export async function loadInitialPreviewBaseline(): Promise<Baseline | undefined> {
  const file = process.env.INITIAL_PUBLISH_BASELINE_FILE
  if (!file) return undefined
  const manifest = SiteSnapshotSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  const versions: Versions = { themeVersion: process.env.PREVIEW_THEME_VERSION ?? '', engineVersion: process.env.PREVIEW_ENGINE_VERSION ?? '', contractVersion: process.env.PREVIEW_CONTRACT_VERSION ?? '' }
  if (Object.values(versions).some((value) => !value)) throw new Error('The configured initial preview baseline requires theme, engine, and contract version pins.')
  return { manifest, sequence: 0, versions }
}

async function latestPublished(payload: Payload, req: PayloadRequest): Promise<Baseline | undefined> {
  const result = await payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true, req })
  const release = result.docs[0]; const snapshot = release?.snapshot
  if (!snapshot || typeof snapshot !== 'object') return undefined
  return { manifest: SiteSnapshotSchema.parse(snapshot.manifest), snapshotID: idOf(snapshot), sequence: Number(release.sequence), versions: { themeVersion: String(snapshot.themeVersion), engineVersion: String(snapshot.engineVersion), contractVersion: String(snapshot.contractVersion) } }
}

async function queueHead(payload: Payload, req: PayloadRequest): Promise<Baseline | undefined> {
  const result = await payload.find({ collection: 'publish-outbox', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true, req })
  const job = result.docs[0]; const snapshot = job?.snapshot
  if (!snapshot || typeof snapshot !== 'object') return undefined
  return { manifest: SiteSnapshotSchema.parse(snapshot.manifest), snapshotID: idOf(snapshot), sequence: Number(job.sequence), versions: { themeVersion: String(snapshot.themeVersion), engineVersion: String(snapshot.engineVersion), contractVersion: String(snapshot.contractVersion) } }
}

/** Prepares exact immutable worker inputs; callers load the configured file before opening SQLite. */
export async function prepareReviewPreview(input: { payload: Payload; req: PayloadRequest; actor: { id: string; roles?: string[] }; id: string; expectedRevision: number; expectedChangeHash: string; includedChangeKeys: string[]; initialBaseline?: Baseline }) {
  const { payload, req, actor, id, expectedRevision, expectedChangeHash, includedChangeKeys, initialBaseline } = input
  requireTransaction(req, 'Review preview preparation')
  if (!actor.roles?.some((role) => role === 'owner' || role === 'approver')) throw new Error('Reviewer role required.')
  if (!includedChangeKeys.length || new Set(includedChangeKeys).size !== includedChangeKeys.length) throw new Error('Preview selection must contain unique captured changes.')
  const set = await payload.findByID({ collection: 'change-sets', id, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>
  const changes = Array.isArray(set.changes) ? set.changes as Change[] : []
  if (set.state !== 'submitted' || Number(set.revision) !== expectedRevision || changeSetHash(changes) !== expectedChangeHash) throw new Error('The reviewed revision no longer matches the submitted change set.')
  const known = new Set(changes.map((change) => `${change.collection}:${change.id}`))
  if (includedChangeKeys.some((key) => !known.has(key))) throw new Error('Preview selection must contain captured changes only.')
  const live = await latestPublished(payload, req) ?? initialBaseline
  const base = await queueHead(payload, req) ?? live
  if (!live || !base) throw new Error('Review preview is unavailable until an initial server-configured baseline is installed.')
  const proposed = buildCandidate(base.manifest, changes, includedChangeKeys, base.versions)
  const liveManifestHash = canonicalHash(live.manifest); const proposedManifestHash = canonicalHash(proposed)
  const existing = await payload.find({ collection: 'preview-render-jobs', where: { and: [{ changeSet: { equals: id } }, { reviewRevision: { equals: expectedRevision } }, { changeHash: { equals: expectedChangeHash } }, { proposedManifestHash: { equals: proposedManifestHash } }] }, sort: '-createdAt', limit: 1, depth: 0, overrideAccess: true, req })
  if (existing.docs[0] && Array.isArray(existing.docs[0].includedChangeKeys) && keysEqual(existing.docs[0].includedChangeKeys as string[], includedChangeKeys)) return existing.docs[0]
  const job = await payload.create({ collection: 'preview-render-jobs', data: { changeSet: id, reviewRevision: expectedRevision, changeHash: expectedChangeHash, includedChangeKeys, baselineSnapshot: base.snapshotID, baselineSequence: base.sequence, liveSnapshot: live.snapshotID, liveSequence: live.sequence, liveManifest: live.manifest, proposedManifest: proposed, liveManifestHash, proposedManifestHash, versionPins: base.versions, status: 'pending', attempts: 0 }, overrideAccess: true, req, context: { editorialInternal: true } })
  await payload.update({ collection: 'change-sets', id, data: { preview: { status: 'queued', jobID: job.id, revision: expectedRevision, changeHash: expectedChangeHash, includedChangeKeys, baselineSnapshotID: base.snapshotID, baselineSequence: base.sequence, liveSnapshotID: live.snapshotID, liveSequence: live.sequence, liveManifestHash, proposedManifestHash } }, overrideAccess: true, req, context: { editorialInternal: true } })
  return job
}

export async function claimPreviewRenderJob(payload: Payload, req: PayloadRequest, now = new Date(), leaseMilliseconds = 60_000) {
  requireTransaction(req, 'Preview claim')
  const found = await payload.find({ collection: 'preview-render-jobs', where: { status: { in: ['pending', 'processing'] } }, sort: 'createdAt', limit: 1, depth: 0, overrideAccess: true, req })
  const job = found.docs[0]; if (!job) return null
  const expired = job.status === 'processing' && job.leaseExpiresAt && new Date(String(job.leaseExpiresAt)).getTime() <= now.getTime()
  if ((job.status === 'pending' && job.nextAttemptAt && new Date(String(job.nextAttemptAt)).getTime() > now.getTime()) || (job.status === 'processing' && !expired)) return null
  if (expired && Number(job.attempts) >= MAX_ATTEMPTS) { await payload.update({ collection: 'preview-render-jobs', id: job.id, data: { status: 'failed', errorCode: 'LEASE_EXPIRED', leaseToken: null, leaseExpiresAt: null }, overrideAccess: true, req, context: { editorialInternal: true } }); return null }
  const leaseToken = randomUUID()
  const claimed = await payload.update({ collection: 'preview-render-jobs', where: { and: [{ id: { equals: job.id } }, { status: { equals: job.status } }] }, data: { status: 'processing', attempts: Number(job.attempts) + 1, leaseToken, leaseExpiresAt: new Date(now.getTime() + leaseMilliseconds).toISOString() }, overrideAccess: true, req, context: { editorialInternal: true } })
  return claimed.docs[0] ?? null
}

function currentLease(job: { status?: string; leaseToken?: string | null; leaseExpiresAt?: string | null }, token: string, now: Date) { return job.status === 'processing' && job.leaseToken === token && job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() > now.getTime() }
export async function renewPreviewRenderLease(payload: Payload, req: PayloadRequest, id: string, leaseToken: string, now = new Date(), leaseMilliseconds = 60_000) { requireTransaction(req, 'Preview renewal'); const job = await payload.findByID({ collection: 'preview-render-jobs', id, depth: 0, overrideAccess: true, req }); if (!currentLease(job, leaseToken, now)) throw new Error('The preview lease is no longer current.'); return payload.update({ collection: 'preview-render-jobs', id, data: { leaseExpiresAt: new Date(now.getTime() + leaseMilliseconds).toISOString() }, overrideAccess: true, req, context: { editorialInternal: true } }) }
export async function completePreviewRenderJob(payload: Payload, req: PayloadRequest, id: string, leaseToken: string, proof: { liveManifestHash: string; proposedManifestHash: string; artifactDigest: string }, now = new Date()) { requireTransaction(req, 'Preview completion'); const job = await payload.findByID({ collection: 'preview-render-jobs', id, depth: 0, overrideAccess: true, req }); if (!currentLease(job, leaseToken, now) || proof.liveManifestHash !== job.liveManifestHash || proof.proposedManifestHash !== job.proposedManifestHash || !/^[a-f0-9]{64}$/i.test(proof.artifactDigest)) throw new Error('Preview completion proof is invalid.'); return payload.update({ collection: 'preview-render-jobs', id, data: { status: 'completed', completedAt: now.toISOString(), artifactDigest: proof.artifactDigest, leaseToken: null, leaseExpiresAt: null }, overrideAccess: true, req, context: { editorialInternal: true } }) }
export async function failPreviewRenderJob(payload: Payload, req: PayloadRequest, id: string, leaseToken: string, errorCode: string, now = new Date()) { requireTransaction(req, 'Preview failure'); const job = await payload.findByID({ collection: 'preview-render-jobs', id, depth: 0, overrideAccess: true, req }); if (!currentLease(job, leaseToken, now) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode)) throw new Error('Preview failure request is invalid.'); const terminal = Number(job.attempts) >= MAX_ATTEMPTS; return payload.update({ collection: 'preview-render-jobs', id, data: { status: terminal ? 'failed' : 'pending', errorCode, nextAttemptAt: terminal ? null : new Date(now.getTime() + 1000 * 2 ** Math.max(0, Number(job.attempts) - 1)).toISOString(), leaseToken: null, leaseExpiresAt: null }, overrideAccess: true, req, context: { editorialInternal: true } }) }

export function workerAuthorized(request: Request): boolean { const token = process.env.PREVIEW_WORKER_TOKEN; const value = request.headers.get('authorization')?.replace(/^Bearer /, ''); return Boolean(token && value && token.length === value.length && timingSafeEqual(Buffer.from(token), Buffer.from(value))) }
export async function boundedJSON(request: Request): Promise<Record<string, unknown>> { const body = await request.text(); if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('Request body too large.'); return JSON.parse(body) as Record<string, unknown> }
