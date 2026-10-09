import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Payload, PayloadRequest } from 'payload'
import { SiteSnapshotSchema, type SiteSnapshot } from '@site-engine/contract'
import { buildCandidate, canonicalHash, changeSetHash } from './publishing'
import { markStaleIfNeeded } from './editorial'

type Versions = { themeVersion: string; engineVersion: string; contractVersion: string }
type PreviewVersions = Versions & { liveThemeVersion?: string; liveContractVersion?: string }
type Change = { collection: 'pages' | 'sections' | 'redirects' | 'theme-settings' | 'site-settings'; id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; beforeHash: string | null; afterHash: string | null }
export type PreviewBaseline = { manifest: SiteSnapshot; snapshotID?: string; sequence: number; versions: Versions }
const MAX_ATTEMPTS = 3
const MAX_BODY_BYTES = 16 * 1024

const idOf = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined
const keysEqual = (left: readonly string[], right: readonly string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
const versionsEqual = (left: unknown, right: PreviewVersions) => Boolean(left && typeof left === 'object' && (left as PreviewVersions).themeVersion === right.themeVersion && (left as PreviewVersions).engineVersion === right.engineVersion && (left as PreviewVersions).contractVersion === right.contractVersion && ((left as PreviewVersions).liveThemeVersion ?? (left as PreviewVersions).themeVersion) === (right.liveThemeVersion ?? right.themeVersion) && ((left as PreviewVersions).liveContractVersion ?? (left as PreviewVersions).contractVersion) === (right.liveContractVersion ?? right.contractVersion))
const requireTransaction = (req: PayloadRequest, operation: string) => { if (!req.transactionID) throw new Error(`${operation} must run inside a database transaction.`) }

function selectionFromJob(job: Record<string, unknown>) {
  const completed = job.status === 'completed' && typeof job.artifactDigest === 'string'
  return {
    status: completed ? 'ready' : 'queued', jobID: job.id, revision: job.reviewRevision, changeHash: job.changeHash,
    includedChangeKeys: job.includedChangeKeys, baselineSnapshotID: idOf(job.baselineSnapshot), baselineSequence: job.baselineSequence,
    liveSnapshotID: idOf(job.liveSnapshot), liveSequence: job.liveSequence, liveManifestHash: job.liveManifestHash,
    proposedManifestHash: job.proposedManifestHash,
    versionPins: job.versionPins,
    ...(completed ? { contentHash: canonicalHash(job.proposedManifest), artifactDigest: job.artifactDigest } : {}),
  }
}

export async function loadInitialPreviewBaseline(): Promise<PreviewBaseline | undefined> {
  const file = process.env.INITIAL_PUBLISH_BASELINE_FILE
  if (!file) return undefined
  const manifest = SiteSnapshotSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  const versions: Versions = { themeVersion: process.env.PREVIEW_THEME_VERSION ?? '', engineVersion: process.env.PREVIEW_ENGINE_VERSION ?? '', contractVersion: process.env.PREVIEW_CONTRACT_VERSION ?? '' }
  if (Object.values(versions).some((value) => !value)) throw new Error('The configured initial preview baseline requires theme, engine, and contract version pins.')
  return { manifest, sequence: 0, versions }
}

async function latestPublished(payload: Payload, req?: PayloadRequest): Promise<PreviewBaseline | undefined> {
  const result = await payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true, ...(req ? { req } : {}) })
  const release = result.docs[0]; const snapshot = release?.snapshot
  if (!snapshot || typeof snapshot !== 'object') return undefined
  return { manifest: SiteSnapshotSchema.parse(snapshot.manifest), snapshotID: idOf(snapshot), sequence: Number(release.sequence), versions: { themeVersion: String(snapshot.themeVersion), engineVersion: String(snapshot.engineVersion), contractVersion: String(snapshot.contractVersion) } }
}

/** The installed public release is authoritative; bootstrap files only apply before first publication. */
export async function loadPublishedPreviewBaseline(payload: Payload): Promise<PreviewBaseline | undefined> {
  return await latestPublished(payload) ?? await loadInitialPreviewBaseline()
}

async function queueHead(payload: Payload, req?: PayloadRequest): Promise<PreviewBaseline | undefined> {
  const result = await payload.find({ collection: 'publish-outbox', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true, ...(req ? { req } : {}) })
  const job = result.docs[0]; const snapshot = job?.snapshot
  if (!snapshot || typeof snapshot !== 'object') return undefined
  return { manifest: SiteSnapshotSchema.parse(snapshot.manifest), snapshotID: idOf(snapshot), sequence: Number(job.sequence), versions: { themeVersion: String(snapshot.themeVersion), engineVersion: String(snapshot.engineVersion), contractVersion: String(snapshot.contractVersion) } }
}

/** The exact baseline selected by preview and publication candidate assembly. */
export async function currentPreviewBaseline(payload: Payload, req?: PayloadRequest): Promise<PreviewBaseline | undefined> {
  const live = await latestPublished(payload, req) ?? await loadInitialPreviewBaseline()
  return await queueHead(payload, req) ?? live
}

/** The candidate's selection is authoritative for approval and publication.
 * Legacy jobs omit the live pins; new jobs preserve both rendered variants. */
function previewVersions(live: PreviewBaseline, proposed: SiteSnapshot, base: PreviewBaseline): PreviewVersions {
  const themeVersion = proposed.settings.theme?.version ?? base.versions.themeVersion
  const liveThemeVersion = live.manifest.settings.theme?.version ?? live.versions.themeVersion
  // Preview workers render both immutable content variants with the currently
  // deployed renderer. A published baseline can legitimately predate an engine
  // rollout, so inheriting its engine pin would make a new review claim
  // unroutable to the configured worker.
  const configuredEngineVersion = process.env.PREVIEW_ENGINE_VERSION
  if (configuredEngineVersion !== undefined && !configuredEngineVersion.trim()) throw new Error('PREVIEW_ENGINE_VERSION must not be blank when configured.')
  return {
    themeVersion,
    engineVersion: configuredEngineVersion ?? base.versions.engineVersion,
    contractVersion: proposed.settings.contractVersion,
    ...(liveThemeVersion === themeVersion ? {} : { liveThemeVersion }),
    ...(live.manifest.settings.contractVersion === proposed.settings.contractVersion ? {} : { liveContractVersion: live.manifest.settings.contractVersion }),
  }
}

export type PreviewThemeIdentity = { name: string; version: string }

function themeIdentity(manifest: SiteSnapshot): PreviewThemeIdentity | undefined {
  const selected = manifest.settings.theme
  return selected ? { name: selected.id, version: selected.version } : undefined
}

/** Resolve the same live and queued baseline used by the real preview worker.
 * Only the public theme identity leaves this server-side helper. */
export async function previewThemeContext(input: {
  payload: Payload
  changeSets: Array<Record<string, unknown>>
  initialBaseline?: PreviewBaseline
  req?: PayloadRequest
}) {
  const live = await latestPublished(input.payload, input.req) ?? input.initialBaseline
  const base = await queueHead(input.payload, input.req) ?? live
  if (!live || !base) return {
    liveManifest: undefined,
    activeTheme: null,
    activeContractVersion: null,
    changeSetThemes: {} as Record<string, PreviewThemeIdentity | null>,
    changeSetContractVersions: {} as Record<string, string | null>,
  }
  const activeTheme = themeIdentity(base.manifest) ?? null
  const changeSetThemes: Record<string, PreviewThemeIdentity | null> = {}
  const changeSetContractVersions: Record<string, string | null> = {}
  for (const set of input.changeSets) {
    const changes = Array.isArray(set.changes) ? set.changes as Change[] : []
    if (!changes.some((change) => change.collection === 'theme-settings')) {
      changeSetThemes[String(set.id)] = activeTheme
      changeSetContractVersions[String(set.id)] = base.manifest.settings.contractVersion
      continue
    }
    const included = changes.map((change) => `${change.collection}:${change.id}`)
    try {
      const candidate = buildCandidate(base.manifest, changes, included, base.versions)
      changeSetThemes[String(set.id)] = themeIdentity(candidate) ?? null
      changeSetContractVersions[String(set.id)] = candidate.settings.contractVersion
    } catch {
      changeSetThemes[String(set.id)] = null
      changeSetContractVersions[String(set.id)] = null
    }
  }
  return {
    liveManifest: live.manifest,
    activeTheme,
    activeContractVersion: base.manifest.settings.contractVersion,
    changeSetThemes,
    changeSetContractVersions,
  }
}

/** Prepares exact immutable worker inputs; callers load the configured file before opening SQLite. */
export async function prepareReviewPreview(input: { payload: Payload; req: PayloadRequest; actor: { id: string; roles?: string[] }; id: string; expectedRevision: number; expectedChangeHash: string; includedChangeKeys: string[]; initialBaseline?: PreviewBaseline; draft?: boolean }) {
  const { payload, req, actor, id, expectedRevision, expectedChangeHash, includedChangeKeys, initialBaseline, draft = false } = input
  requireTransaction(req, 'Review preview preparation')
  const reviewer = await payload.findByID({ collection: 'users', id: actor.id, depth: 0, overrideAccess: true, req }) as { disabled?: boolean; roles?: string[] }
  if (reviewer.disabled || !(draft ? reviewer.roles?.some((role) => role === 'owner' || role === 'editor' || role === 'approver') : reviewer.roles?.some((role) => role === 'owner' || role === 'approver'))) throw new Error(draft ? 'Page editor role required.' : 'Reviewer role required.')
  if (!includedChangeKeys.length || new Set(includedChangeKeys).size !== includedChangeKeys.length) throw new Error('Preview selection must contain unique captured changes.')
  let set = await payload.findByID({ collection: 'change-sets', id, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>
  set = await markStaleIfNeeded(payload, set, req)
  const changes = Array.isArray(set.changes) ? set.changes as Change[] : []
  if ((draft ? !['open', 'changes-requested'].includes(String(set.state)) || idOf(set.actor) !== actor.id : set.state !== 'submitted') || Number(set.revision) !== expectedRevision || changeSetHash(changes) !== expectedChangeHash) throw new Error(draft ? 'The editable draft has changed.' : 'The reviewed revision no longer matches the submitted change set.')
  const checks = (set.quality as { checks?: { status?: string }[] } | undefined)?.checks
  if (!draft && (!checks?.length || checks.some((check) => check.status !== 'passed'))) throw new Error('Review checks must pass before preparing a preview.')
  const known = new Set(changes.map((change) => `${change.collection}:${change.id}`))
  if (includedChangeKeys.some((key) => !known.has(key))) throw new Error('Preview selection must contain captured changes only.')
  const live = await latestPublished(payload, req) ?? initialBaseline
  const base = await queueHead(payload, req) ?? live
  if (!live || !base) throw new Error('Review preview is unavailable until an initial server-configured baseline is installed.')
  const proposed = buildCandidate(base.manifest, changes, includedChangeKeys, base.versions)
  const pinnedVersions = previewVersions(live, proposed, base)
  const liveManifestHash = canonicalHash(live.manifest); const proposedManifestHash = canonicalHash(proposed)
  const existing = await payload.find({ collection: 'preview-render-jobs', where: { and: [{ changeSet: { equals: id } }, { reviewRevision: { equals: expectedRevision } }, { changeHash: { equals: expectedChangeHash } }, { proposedManifestHash: { equals: proposedManifestHash } }, { liveManifestHash: { equals: liveManifestHash } }, { baselineSequence: { equals: base.sequence } }, { liveSequence: { equals: live.sequence } }] }, sort: '-createdAt', limit: 1, depth: 0, overrideAccess: true, req })
  const duplicate = existing.docs[0]
  if (duplicate && duplicate.status !== 'failed' && Array.isArray(duplicate.includedChangeKeys) && keysEqual(duplicate.includedChangeKeys as string[], includedChangeKeys) && idOf(duplicate.baselineSnapshot) === base.snapshotID && idOf(duplicate.liveSnapshot) === live.snapshotID && versionsEqual(duplicate.versionPins, pinnedVersions)) {
    if (!draft) await payload.update({ collection: 'change-sets', id, data: { preview: selectionFromJob(duplicate as unknown as Record<string, unknown>) }, overrideAccess: true, req, context: { editorialInternal: true } })
    return duplicate
  }
  const job = await payload.create({ collection: 'preview-render-jobs', data: { changeSet: id, reviewRevision: expectedRevision, changeHash: expectedChangeHash, includedChangeKeys, baselineSnapshot: base.snapshotID, baselineSequence: base.sequence, liveSnapshot: live.snapshotID, liveSequence: live.sequence, liveManifest: live.manifest, proposedManifest: proposed, liveManifestHash, proposedManifestHash, versionPins: pinnedVersions, status: 'pending', attempts: 0 }, overrideAccess: true, req, context: { editorialInternal: true } })
  if (!draft) await payload.update({ collection: 'change-sets', id, data: { preview: selectionFromJob(job as unknown as Record<string, unknown>) }, overrideAccess: true, req, context: { editorialInternal: true } })
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
export async function completePreviewRenderJob(payload: Payload, req: PayloadRequest, id: string, leaseToken: string, proof: { liveManifestHash: string; proposedManifestHash: string; artifactDigest: string }, now = new Date()) {
  requireTransaction(req, 'Preview completion')
  const job = await payload.findByID({ collection: 'preview-render-jobs', id, depth: 0, overrideAccess: true, req })
  if (job.status === 'completed') {
    if (job.artifactDigest !== proof.artifactDigest || proof.liveManifestHash !== job.liveManifestHash || proof.proposedManifestHash !== job.proposedManifestHash) throw new Error('Preview completion proof is invalid.')
    return job
  }
  if (!currentLease(job, leaseToken, now) || proof.liveManifestHash !== job.liveManifestHash || proof.proposedManifestHash !== job.proposedManifestHash || !/^[a-f0-9]{64}$/i.test(proof.artifactDigest)) throw new Error('Preview completion proof is invalid.')
  const completed = await payload.update({ collection: 'preview-render-jobs', id, data: { status: 'completed', completedAt: now.toISOString(), artifactDigest: proof.artifactDigest, renderDiagnostics: null, leaseToken: null, leaseExpiresAt: null }, overrideAccess: true, req, context: { editorialInternal: true } })
  const set = await payload.findByID({ collection: 'change-sets', id: String(job.changeSet), depth: 0, overrideAccess: true, req })
  const preview = set.preview as { jobID?: string; revision?: number; changeHash?: string; baselineSequence?: number; includedChangeKeys?: string[] } | undefined
  if (preview?.jobID === id && preview.revision === job.reviewRevision && preview.changeHash === job.changeHash && preview.baselineSequence === job.baselineSequence && Array.isArray(preview.includedChangeKeys) && keysEqual(preview.includedChangeKeys, job.includedChangeKeys as string[])) {
    // Approval verifies the exact candidate content hash.  It must be derived
    // from this immutable worker input, never supplied by the browser.
    await payload.update({ collection: 'change-sets', id: String(job.changeSet), data: { preview: { ...preview, status: 'ready', contentHash: canonicalHash(job.proposedManifest), artifactDigest: proof.artifactDigest, baselineSnapshotID: idOf(job.baselineSnapshot), liveSnapshotID: idOf(job.liveSnapshot), liveSequence: job.liveSequence, liveManifestHash: job.liveManifestHash, proposedManifestHash: job.proposedManifestHash, versionPins: job.versionPins } }, overrideAccess: true, req, context: { editorialInternal: true } })
  }
  return completed
}
type RenderDiagnostic = { code: string; path: string; message: string; pageId?: string; blockId?: string }
function diagnostics(value: unknown): RenderDiagnostic[] | undefined {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Preview failure request is invalid.')
  const result = value.map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : undefined).map((item) => {
    if (!item || !/^[A-Z][A-Z0-9_]{0,63}$/.test(String(item.code)) || typeof item.path !== 'string' || item.path.length > 300 || typeof item.message !== 'string' || item.message.length > 500 || (item.pageId !== undefined && (typeof item.pageId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.pageId))) || (item.blockId !== undefined && (typeof item.blockId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.blockId)))) throw new Error('Preview failure request is invalid.')
    return { code: String(item.code), path: item.path, message: item.message, ...(typeof item.pageId === 'string' ? { pageId: item.pageId } : {}), ...(typeof item.blockId === 'string' ? { blockId: item.blockId } : {}) }
  })
  return result
}
export async function failPreviewRenderJob(payload: Payload, req: PayloadRequest, id: string, leaseToken: string, errorCode: string, now = new Date(), renderDiagnostics?: unknown) { requireTransaction(req, 'Preview failure'); const job = await payload.findByID({ collection: 'preview-render-jobs', id, depth: 0, overrideAccess: true, req }); if (!currentLease(job, leaseToken, now) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode)) throw new Error('Preview failure request is invalid.'); const safeDiagnostics = renderDiagnostics === undefined ? undefined : diagnostics(renderDiagnostics); const terminal = Number(job.attempts) >= MAX_ATTEMPTS; return payload.update({ collection: 'preview-render-jobs', id, data: { status: terminal ? 'failed' : 'pending', errorCode, renderDiagnostics: safeDiagnostics ?? null, nextAttemptAt: terminal ? null : new Date(now.getTime() + 1000 * 2 ** Math.max(0, Number(job.attempts) - 1)).toISOString(), leaseToken: null, leaseExpiresAt: null }, overrideAccess: true, req, context: { editorialInternal: true } }) }

export function workerAuthorized(request: Request): boolean {
  const secret = process.env.PREVIEW_WORKER_TOKEN
  const authorization = request.headers.get('authorization')
  if (!secret || Buffer.byteLength(secret) < 32 || !authorization?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(authorization.slice('Bearer '.length))
  const expected = Buffer.from(secret)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export async function boundedJSON(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {}
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('Request body too large.') }; chunks.push(next.value) } } finally { reader.releaseLock() }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as Record<string, unknown>
}
