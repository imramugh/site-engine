import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { withPayloadTransaction } from '../src/auth-transaction'
import { approveChangeSet, buildCandidate, canonicalHash, changeSetHash } from '../src/publishing'
import { loadPublishedPreviewBaseline, boundedJSON, claimPreviewRenderJob, completePreviewRenderJob, failPreviewRenderJob, prepareReviewPreview, renewPreviewRenderLease, workerAuthorized } from '../src/review-preview'
import { runReviewQuality } from '../src/review-quality'
import { loadReviewModeData, loadReviewModePages, routeForReviewPreview } from '../src/review-mode'
import { hashOpaqueToken, newOpaqueToken } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-review-preview-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-review-preview'
process.env.PREVIEW_WORKER_TOKEN = 'worker-token-long-enough-to-be-a-real-test-secret'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
const { default: config } = await import('../payload.config.js')
const reviewSessionRoute = await import('../app/api/auth/preview/review-session/route.js')
const editorialRoute = await import('../app/api/editorial/[action]/route.js')
const reviewModeRoute = await import('../app/api/editorial/review/[id]/route.js')
const pageReviewEntryRoute = await import('../app/api/editorial/page-review-entry/route.js')
const directPreviewRoute = await import('../app/api/editorial/direct-edit/preview/route.js')
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

async function fixture(label: string, options: { installed?: boolean; secondPage?: boolean } = {}) {
  const reviewer = await payload.create({ collection: 'users', data: { email: `${label}-${randomUUID()}@example.test`, name: 'Reviewer', roles: ['approver'] }, overrideAccess: true })
  const editor = await payload.create({ collection: 'users', data: { email: `${label}-editor-${randomUUID()}@example.test`, name: 'Editor', roles: ['editor'] }, overrideAccess: true })
  const live = baseline(); const page = live.pages[0]!; const before = { ...page, status: undefined }; delete (before as { status?: unknown }).status
  const after = { ...before, title: `Proposed ${label}` }
  const changes: Change[] = [{ collection: 'pages', id: page.id, before, after, beforeHash: canonicalHash(before), afterHash: null }]
  if (options.secondPage) {
    const second = { ...structuredClone(page), id: randomUUID(), title: `Second ${label}`, slug: `second-${page.id.slice(0, 8)}` }
    live.pages.push(second); live.settings.sections[0]!.pageIds.push(second.id)
    const secondBefore = { ...second, status: undefined }; delete (secondBefore as { status?: unknown }).status
    changes.push({ collection: 'pages', id: second.id, before: secondBefore, after: { ...secondBefore, title: `Proposed second ${label}` }, beforeHash: canonicalHash(secondBefore), afterHash: null })
  }
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
  return withPayloadTransaction(payload, req => prepareReviewPreview({ payload, req, actor: current.reviewer, id: String(current.set.id), expectedRevision: 4, expectedChangeHash: changeSetHash(current.changes), includedChangeKeys: current.changes.filter((change) => change.collection === 'pages').map((change) => `pages:${change.id}`), initialBaseline }))
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


describe('immutable screenshot evidence endpoint', () => {
  it('authorizes reviewers and fails closed for expiry and tampering', async () => {
    const current = await fixture('evidence-endpoint'); const job = await prepare(current)
    const root = mkdtempSync(join(tmpdir(), 'evidence-artifacts-')); process.env.PREVIEW_ARTIFACT_ROOT = root
    const bytes = Buffer.from([137,80,78,71,13,10,26,10,0]); const { createHash } = await import('node:crypto'); const sha256 = createHash('sha256').update(bytes).digest('hex')
    mkdirSync(join(root, String(job.id), 'evidence'), { recursive: true }); writeFileSync(join(root, String(job.id), 'evidence', 'proposed.png'), bytes)
    const manifest = { version: 1, state: 'available', jobID: String(job.id), route: '/', viewport: { width: 1440, height: 900 }, liveManifestHash: String(job.liveManifestHash), proposedManifestHash: String(job.proposedManifestHash), screenshots: { live: { path: 'evidence/live.png', bytes: bytes.length, sha256, route: '/', status: 200 }, proposed: { path: 'evidence/proposed.png', bytes: bytes.length, sha256, route: '/', status: 200 } } }
    await payload.update({ collection: 'preview-render-jobs', id: job.id, data: { status: 'completed', completedAt: new Date().toISOString(), artifactDigest: digest, evidenceManifest: manifest }, overrideAccess: true, context: { editorialInternal: true } })
    const route = await import('../app/api/auth/preview/evidence/[jobID]/[variant]/route.js'); const call = (headers: Headers) => route.GET(new Request('http://cms.test/api/auth/preview/evidence', { headers }), { params: Promise.resolve({ jobID: String(job.id), variant: 'proposed' }) })
    expect((await call(current.headers)).status).toBe(200); expect((await call(await reviewHeaders('owner'))).status).toBe(200); expect((await call(await reviewHeaders('editor'))).status).toBe(403); expect((await call(new Headers())).status).toBe(401)
    await payload.update({ collection: 'preview-render-jobs', id: job.id, data: { completedAt: new Date(Date.now() - 31 * 86_400_000).toISOString() }, overrideAccess: true, context: { editorialInternal: true } }); expect((await call(current.headers)).status).toBe(404); await payload.update({ collection: 'preview-render-jobs', id: job.id, data: { completedAt: new Date().toISOString() }, overrideAccess: true, context: { editorialInternal: true } }); writeFileSync(join(root, String(job.id), 'evidence', 'proposed.png'), Buffer.from('tampered')); expect((await call(current.headers)).status).toBe(404)
    rmSync(root, { recursive: true, force: true }); delete process.env.PREVIEW_ARTIFACT_ROOT
  })
})
