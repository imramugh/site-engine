import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { withPayloadTransaction } from '../src/auth-transaction'
import { approveChangeSet, buildCandidate, canonicalHash, changeSetHash } from '../src/publishing'
import { boundedJSON, claimPreviewRenderJob, completePreviewRenderJob, failPreviewRenderJob, prepareReviewPreview, renewPreviewRenderLease, workerAuthorized } from '../src/review-preview'
import { runReviewQuality } from '../src/review-quality'
import { hashOpaqueToken, newOpaqueToken } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-review-preview-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-review-preview'
process.env.PREVIEW_WORKER_TOKEN = 'worker-token-long-enough-to-be-a-real-test-secret'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
const { default: config } = await import('../payload.config.js')
const reviewSessionRoute = await import('../app/api/auth/preview/review-session/route.js')
const editorialRoute = await import('../app/api/editorial/[action]/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>
const versions = { themeVersion: 'theme-test-1', engineVersion: 'engine-test-1', contractVersion: '1.0.0' }
const digest = 'a'.repeat(64)
type Change = { collection: 'pages'; id: string; before: Record<string, unknown>; after: Record<string, unknown>; beforeHash: string; afterHash: null }

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })
beforeEach(async () => {
  // Each proof must choose its own live and queue-head baseline.
  await payload.delete({ collection: 'preview-render-jobs', where: { id: { exists: true } }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.delete({ collection: 'published-releases', where: { id: { exists: true } }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.delete({ collection: 'publish-outbox', where: { id: { exists: true } }, overrideAccess: true, context: { editorialInternal: true } })
})

function baseline() {
  const value = structuredClone(neutralFixture)
  const sectionID = randomUUID(); const pageID = randomUUID(); const suffix = pageID.slice(0, 8)
  value.settings.homepageId = pageID
  value.settings.sections[0]!.id = sectionID; value.settings.sections[0]!.pageIds = [pageID]; value.settings.sections[0]!.slug = `review-${suffix}`
  value.pages[0]!.id = pageID; value.pages[0]!.sectionId = sectionID; value.pages[0]!.slug = `review-${suffix}`
  return value
}

async function fixture(label: string, options: { installed?: boolean } = {}) {
  const reviewer = await payload.create({ collection: 'users', data: { email: `${label}-${randomUUID()}@example.test`, name: 'Reviewer', roles: ['approver'] }, overrideAccess: true })
  const editor = await payload.create({ collection: 'users', data: { email: `${label}-editor-${randomUUID()}@example.test`, name: 'Editor', roles: ['editor'] }, overrideAccess: true })
  const live = baseline(); const page = live.pages[0]!; const before = { ...page, status: undefined }; delete (before as { status?: unknown }).status
  const after = { ...before, title: `Proposed ${label}` }
  const changes: Change[] = [{ collection: 'pages', id: page.id, before, after, beforeHash: canonicalHash(before), afterHash: null }]
  const set = await payload.create({ collection: 'change-sets', data: { name: label, actor: editor.id, state: 'submitted', revision: 4, changes, quality: { checks: [{ name: 'contract-and-tree', status: 'passed' }] }, preview: { status: 'pending' } }, overrideAccess: true, context: { editorialInternal: true } })
  let snapshotID: string | undefined
  if (options.installed !== false) {
    const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: canonicalHash(live), changeSet: set.id, reviewRevision: 0, changeHash: 'baseline', manifest: live, ...versions, approvedBy: reviewer.id, baselineSequence: 0 }, overrideAccess: true, context: { editorialInternal: true } })
    snapshotID = String(snapshot.id)
    const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: `baseline:${snapshot.id}`, sequence: 1, snapshot: snapshot.id, changeSet: set.id, reviewRevision: 0, changeHash: 'baseline', includedChangeKeys: [], status: 'completed', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
    await payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence: 1, snapshot: snapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { status: 'healthy' }, artifact: { digest, sourceContentHash: snapshot.contentHash, ...versions, checks: [{ name: 'artifact-integrity', status: 'passed' }, { name: 'public-health', status: 'passed' }] } }, overrideAccess: true, context: { editorialInternal: true } })
  }
  const token = newOpaqueToken(); const now = new Date().toISOString()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: reviewer.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  return { reviewer, editor, set, changes, live, snapshotID, headers: new Headers({ cookie: `site_engine_session=${token}` }) }
}

async function prepare(current: Awaited<ReturnType<typeof fixture>>, initialBaseline?: { manifest: ReturnType<typeof baseline>; sequence: number; versions: typeof versions }) {
  return withPayloadTransaction(payload, req => prepareReviewPreview({ payload, req, actor: current.reviewer, id: String(current.set.id), expectedRevision: 4, expectedChangeHash: changeSetHash(current.changes), includedChangeKeys: [`pages:${current.changes[0]!.id}`], initialBaseline }))
}

async function reviewSession(headers: Headers, path: string) {
  return reviewSessionRoute.GET(new Request('http://localhost/api/auth/preview/review-session', { headers: { cookie: headers.get('cookie')!, 'x-original-uri': path } }))
}

async function headersFor(user: { id: string }) {
  const token = newOpaqueToken(); const now = new Date().toISOString()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  return new Headers({ cookie: `site_engine_session=${token}` })
}

async function reviewHeaders(role: 'owner' | 'editor') {
  const user = await payload.create({ collection: 'users', data: { email: `${role}-${randomUUID()}@example.test`, name: role, roles: [role] }, overrideAccess: true })
  const token = newOpaqueToken(); const now = new Date().toISOString()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  return new Headers({ cookie: `site_engine_session=${token}` })
}

describe('ENG-030 immutable review preview jobs', () => {
  it('prepares immutable live/proposed inputs, canonical reviewer state, stale revisions, and exact deduplication', async () => {
    const current = await fixture('prepare')
    const job = await prepare(current)
    expect(job).toMatchObject({ status: 'pending', baselineSequence: 1, liveSequence: 1, versionPins: versions })
    expect(canonicalHash(job.liveManifest)).toBe(job.liveManifestHash)
    expect(canonicalHash(job.proposedManifest)).toBe(job.proposedManifestHash)
    expect((job.proposedManifest as typeof current.live).pages[0]?.title).toBe('Proposed prepare')
    expect((await prepare(current)).id).toBe(job.id)
    await payload.update({ collection: 'users', id: current.reviewer.id, data: { disabled: true }, overrideAccess: true })
    await expect(prepare(current)).rejects.toThrow('Reviewer role required')
    await payload.update({ collection: 'users', id: current.reviewer.id, data: { disabled: false, roles: ['approver'] }, overrideAccess: true })
    await payload.update({ collection: 'change-sets', id: current.set.id, data: { revision: 5 }, overrideAccess: true, context: { editorialInternal: true } })
    await expect(prepare(current)).rejects.toThrow('reviewed revision')
  })

  it('does not deduplicate jobs whose immutable version pins differ', async () => {
    const current = await fixture('versions', { installed: false })
    const first = await prepare(current, { manifest: current.live, sequence: 0, versions })
    const second = await prepare(current, { manifest: current.live, sequence: 0, versions: { ...versions, themeVersion: 'theme-test-2' } })
    expect(second.id).not.toBe(first.id)
    expect(second.versionPins).toMatchObject({ themeVersion: 'theme-test-2' })
  })

  it('retains a legacy baseline contract for ordinary content even when the server default advances', async () => {
    const current = await fixture('retain-contract', { installed: false })
    const candidate = buildCandidate(current.live, current.changes, [`pages:${current.changes[0]!.id}`], { ...versions, contractVersion: '1.1.0' })
    expect(candidate.settings.contractVersion).toBe('1.0.0')
  })

  it('leases with bounded retries, renewal, proof validation, atomic completion, idempotence, and protects a newer selection', async () => {
    const current = await fixture('leases')
    const job = await prepare(current)
    const started = new Date('2026-10-03T18:00:00.000Z')
    const lease = await withPayloadTransaction(payload, req => claimPreviewRenderJob(payload, req, started, 1_000))
    expect(lease).toMatchObject({ id: job.id, attempts: 1, status: 'processing' })
    await expect(withPayloadTransaction(payload, req => renewPreviewRenderLease(payload, req, String(job.id), 'wrong', started))).rejects.toThrow('no longer current')
    const renewed = await withPayloadTransaction(payload, req => renewPreviewRenderLease(payload, req, String(job.id), String(lease!.leaseToken), started, 1_000))
    expect(new Date(String(renewed.leaseExpiresAt)).getTime()).toBe(started.getTime() + 1_000)
    await expect(withPayloadTransaction(payload, req => completePreviewRenderJob(payload, req, String(job.id), String(lease!.leaseToken), { liveManifestHash: 'bad', proposedManifestHash: String(job.proposedManifestHash), artifactDigest: digest }, started))).rejects.toThrow('proof')
    await expect(withPayloadTransaction(payload, async req => { await completePreviewRenderJob(payload, req, String(job.id), String(lease!.leaseToken), { liveManifestHash: String(job.liveManifestHash), proposedManifestHash: String(job.proposedManifestHash), artifactDigest: digest }, started); throw new Error('rollback') })).rejects.toThrow('rollback')
    expect((await payload.findByID({ collection: 'preview-render-jobs', id: job.id, overrideAccess: true })).status).toBe('processing')
    const completed = await withPayloadTransaction(payload, req => completePreviewRenderJob(payload, req, String(job.id), String(lease!.leaseToken), { liveManifestHash: String(job.liveManifestHash), proposedManifestHash: String(job.proposedManifestHash), artifactDigest: digest }, started))
    const set = await payload.findByID({ collection: 'change-sets', id: current.set.id, overrideAccess: true })
    expect(set.preview).toMatchObject({ status: 'ready', jobID: job.id, contentHash: canonicalHash(job.proposedManifest), artifactDigest: digest })
    await expect(withPayloadTransaction(payload, req => completePreviewRenderJob(payload, req, String(job.id), 'old-token', { liveManifestHash: String(job.liveManifestHash), proposedManifestHash: String(job.proposedManifestHash), artifactDigest: digest }, new Date(started.getTime() + 1)))).resolves.toMatchObject({ id: completed.id })
    const candidate = buildCandidate(current.live, current.changes, [`pages:${current.changes[0]!.id}`], versions)
    await withPayloadTransaction(payload, req => runReviewQuality({ payload, req, id: String(current.set.id) }))
    const approved = await withPayloadTransaction(payload, req => { req.headers = current.headers; return approveChangeSet({ payload, req, actor: current.reviewer, id: String(current.set.id), expectedRevision: 4, expectedChangeHash: changeSetHash(current.changes), includedChangeKeys: [`pages:${current.changes[0]!.id}`], previewContentHash: canonicalHash(candidate), versions, initialBaseline: current.live }) })
    expect(approved.outboxID).toBeTruthy()
  })

  it('does not let an older completed job replace a newer preview selection', async () => {
    const current = await fixture('newer-selection')
    const job = await prepare(current)
    const lease = await withPayloadTransaction(payload, req => claimPreviewRenderJob(payload, req))
    await payload.update({ collection: 'change-sets', id: current.set.id, data: { preview: { status: 'queued', jobID: randomUUID(), revision: 5, changeHash: 'newer-selection', includedChangeKeys: [] } }, overrideAccess: true, context: { editorialInternal: true } })
    await withPayloadTransaction(payload, req => completePreviewRenderJob(payload, req, String(job.id), String(lease!.leaseToken), { liveManifestHash: String(job.liveManifestHash), proposedManifestHash: String(job.proposedManifestHash), artifactDigest: digest }))
    expect((await payload.findByID({ collection: 'change-sets', id: current.set.id, overrideAccess: true })).preview).toMatchObject({ status: 'queued', revision: 5, changeHash: 'newer-selection' })
  })

  it('terminates expired leases after three attempts and guards worker credentials and bodies', async () => {
    const current = await fixture('retries')
    const job = await prepare(current)
    const start = new Date('2026-10-03T19:00:00.000Z')
    let lease = await withPayloadTransaction(payload, req => claimPreviewRenderJob(payload, req, start, 100))
    for (let attempt = 1; attempt < 3; attempt++) {
      await withPayloadTransaction(payload, req => failPreviewRenderJob(payload, req, String(job.id), String(lease!.leaseToken), 'RENDER_TIMEOUT', new Date(start.getTime() + attempt * 10)))
      lease = await withPayloadTransaction(payload, req => claimPreviewRenderJob(payload, req, new Date(start.getTime() + attempt * 10 + 1_000 * 2 ** (attempt - 1)), 100))
    }
    expect(lease?.attempts).toBe(3)
    expect(await withPayloadTransaction(payload, req => claimPreviewRenderJob(payload, req, new Date(start.getTime() + 9_000), 100))).toBeNull()
    expect(await payload.findByID({ collection: 'preview-render-jobs', id: job.id, overrideAccess: true })).toMatchObject({ status: 'failed', errorCode: 'LEASE_EXPIRED' })
    expect((await prepare(current)).id).not.toBe(job.id)
    expect(workerAuthorized(new Request('http://test', { headers: { authorization: `Bearer ${process.env.PREVIEW_WORKER_TOKEN}` } }))).toBe(true)
    expect(workerAuthorized(new Request('http://test', { headers: { authorization: 'Bearer short' } }))).toBe(false)
    await expect(boundedJSON(new Request('http://test', { method: 'POST', body: 'x'.repeat(16 * 1024 + 1) }))).rejects.toThrow('too large')
    await expect(boundedJSON(new Request('http://test', { method: 'POST', body: '{' }))).rejects.toThrow()
  })

  it('scopes completed draft previews to the owning Editor or an Owner without populating reviewer proof', async () => {
    const current = await fixture('draft-session')
    const editorHeaders = await headersFor(current.editor)
    await payload.update({ collection: 'change-sets', id: current.set.id, data: { state: 'open', preview: null }, overrideAccess: true, context: { editorialInternal: true } })
    const job = await withPayloadTransaction(payload, req => prepareReviewPreview({ payload, req, actor: current.editor, id: String(current.set.id), expectedRevision: 4, expectedChangeHash: changeSetHash(current.changes), includedChangeKeys: [`pages:${current.changes[0]!.id}`], draft: true }))
    const lease = await withPayloadTransaction(payload, req => claimPreviewRenderJob(payload, req))
    await withPayloadTransaction(payload, req => completePreviewRenderJob(payload, req, String(job.id), String(lease!.leaseToken), { liveManifestHash: String(job.liveManifestHash), proposedManifestHash: String(job.proposedManifestHash), artifactDigest: digest }))
    const path = `/preview/changes/${job.id}/proposed/`
    expect((await reviewSession(editorHeaders, path)).status).toBe(204)
    expect((await reviewSession(await reviewHeaders('editor'), path)).status).toBe(403)
    expect((await reviewSession(await reviewHeaders('owner'), path)).status).toBe(204)
    expect((await payload.findByID({ collection: 'change-sets', id: current.set.id, overrideAccess: true })).preview).toBeNull()
    await payload.update({ collection: 'change-sets', id: current.set.id, data: { revision: 5 }, overrideAccess: true, context: { editorialInternal: true } })
    expect((await reviewSession(editorHeaders, path)).status).toBe(403)
    expect((await reviewSession(new Headers(), path)).status).toBe(401)
  })

  it('authorizes only the current completed comparison and its safe nested artifacts', async () => {
    const current = await fixture('review-session')
    const job = await prepare(current)
    const root = `/preview/changes/${job.id}/live/`
    expect((await reviewSession(current.headers, root)).status).toBe(403)
    expect((await reviewSession(current.headers, `/preview/changes/${job.id}/proposed/assets/app.js?cache=1`)).status).toBe(403)
    expect((await reviewSession(current.headers, '/preview/changes/10000000-0000-4000-8000-000000000001/live/')).status).not.toBe(204)

    await payload.update({ collection: 'preview-render-jobs', id: job.id, data: { status: 'failed', errorCode: 'RENDER_TIMEOUT' }, overrideAccess: true, context: { editorialInternal: true } })
    expect((await reviewSession(current.headers, root)).status).toBe(403)
    await payload.update({ collection: 'preview-render-jobs', id: job.id, data: { status: 'pending', errorCode: null }, overrideAccess: true, context: { editorialInternal: true } })

    const lease = await withPayloadTransaction(payload, req => claimPreviewRenderJob(payload, req))
    await withPayloadTransaction(payload, req => completePreviewRenderJob(payload, req, String(job.id), String(lease!.leaseToken), { liveManifestHash: String(job.liveManifestHash), proposedManifestHash: String(job.proposedManifestHash), artifactDigest: digest }))
    expect((await reviewSession(current.headers, root)).status).toBe(204)
    expect((await reviewSession(await reviewHeaders('owner'), root)).status).toBe(204)
    expect((await reviewSession(await reviewHeaders('editor'), root)).status).toBe(403)
    expect((await reviewSession(current.headers, `/preview/changes/${job.id}/proposed/assets/app.js?cache=1`)).status).toBe(204)
    expect((await reviewSession(current.headers, `/preview/changes/${job.id}/live/%2e%2e/proposed/`)).status).toBe(403)
    expect((await reviewSession(current.headers, `/preview/changes/${job.id}/live/assets%2fprivate.js`)).status).toBe(403)
    expect((await reviewSession(current.headers, `/preview/changes/${job.id}/live/../../10000000-0000-4000-8000-000000000001/proposed/`)).status).toBe(403)

    await payload.update({ collection: 'change-sets', id: current.set.id, data: { revision: 5 }, overrideAccess: true, context: { editorialInternal: true } })
    expect((await reviewSession(current.headers, root)).status).toBe(403)

    await payload.update({ collection: 'change-sets', id: current.set.id, data: { preview: { status: 'queued', jobID: job.id } }, overrideAccess: true, context: { editorialInternal: true } })
    expect((await reviewSession(current.headers, root)).status).toBe(403)
    const sessions = await payload.find({ collection: 'auth-sessions', where: { user: { equals: current.reviewer.id } }, limit: 1, overrideAccess: true })
    await payload.update({ collection: 'auth-sessions', id: sessions.docs[0]!.id, data: { revokedAt: new Date().toISOString() }, overrideAccess: true })
    expect((await reviewSession(current.headers, root)).status).toBe(401)
  })

  it('reselects an exact completed job with its immutable ready proof', async () => {
    const current = await fixture('reselect-completed')
    const job = await prepare(current)
    const lease = await withPayloadTransaction(payload, req => claimPreviewRenderJob(payload, req))
    await withPayloadTransaction(payload, req => completePreviewRenderJob(payload, req, String(job.id), String(lease!.leaseToken), { liveManifestHash: String(job.liveManifestHash), proposedManifestHash: String(job.proposedManifestHash), artifactDigest: digest }))

    await payload.update({ collection: 'change-sets', id: current.set.id, data: { preview: { status: 'queued', jobID: randomUUID(), revision: 4, changeHash: 'other-proof' } }, overrideAccess: true, context: { editorialInternal: true } })
    const reselected = await prepare(current)
    expect(reselected.id).toBe(job.id)
    expect((await payload.findByID({ collection: 'change-sets', id: current.set.id, overrideAccess: true })).preview).toMatchObject({ status: 'ready', jobID: job.id, contentHash: canonicalHash(job.proposedManifest), artifactDigest: digest })
    await withPayloadTransaction(payload, req => runReviewQuality({ payload, req, id: String(current.set.id) }))
    const approved = await withPayloadTransaction(payload, req => { req.headers = current.headers; return approveChangeSet({ payload, req, actor: current.reviewer, id: String(current.set.id), expectedRevision: 4, expectedChangeHash: changeSetHash(current.changes), includedChangeKeys: [`pages:${current.changes[0]!.id}`], previewContentHash: canonicalHash(job.proposedManifest), versions, initialBaseline: current.live }) })
    expect(approved.outboxID).toBeTruthy()
  })

  it('accepts a legacy same-contract approval proof without live variant pins', async () => {
    const current = await fixture('legacy-api-proof')
    const job = await prepare(current)
    const lease = await withPayloadTransaction(payload, req => claimPreviewRenderJob(payload, req))
    await withPayloadTransaction(payload, req => completePreviewRenderJob(payload, req, String(job.id), String(lease!.leaseToken), { liveManifestHash: String(job.liveManifestHash), proposedManifestHash: String(job.proposedManifestHash), artifactDigest: digest }))
    await withPayloadTransaction(payload, req => runReviewQuality({ payload, req, id: String(current.set.id) }))
    const set = await payload.findByID({ collection: 'change-sets', id: current.set.id, overrideAccess: true })
    const proof = structuredClone((set.quality as { proof: { versionPins: Record<string, unknown> } }).proof)
    delete proof.versionPins.liveThemeVersion
    delete proof.versionPins.liveContractVersion
    const response = await editorialRoute.POST(new Request('http://cms.test/api/editorial/approve', { method: 'POST', headers: { origin: 'http://cms.test', 'content-type': 'application/json', cookie: current.headers.get('cookie')! }, body: JSON.stringify({ id: current.set.id, proof }) }), { params: Promise.resolve({ action: 'approve' }) })
    expect(response.status).toBe(200)
  })
})
