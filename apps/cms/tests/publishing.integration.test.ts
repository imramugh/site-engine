import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { withPayloadTransaction } from '../src/auth-transaction'
import { approveChangeSet, buildCandidate, canonicalHash, cancelScheduledPublication, changeSetHash, claimNextPublishJob, completePublishJob, dispatchDueScheduledPublications, renewPublishLease, reschedulePublication, retryPublishJob, scheduledPublicationTime } from '../src/publishing'
import { hashOpaqueToken, newOpaqueToken } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-publishing-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-publishing'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
const { default: config } = await import('../payload.config.js')
const scheduledPublicationRoute = await import('../app/api/editorial/schedules/[action]/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })
afterEach(async () => {
  await payload.delete({ collection: 'published-releases', where: { id: { exists: true } }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.delete({ collection: 'scheduled-publications', where: { id: { exists: true } }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.delete({ collection: 'publish-outbox', where: { id: { exists: true } }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.delete({ collection: 'publish-snapshots', where: { id: { exists: true } }, overrideAccess: true, context: { editorialInternal: true } })
})

const versions = { themeVersion: '1.2.3', engineVersion: '1.2.3', contractVersion: '1.0.0' }
type Change = { collection: 'pages' | 'sections' | 'redirects'; id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; beforeHash: string | null; afterHash: string | null }
function passingQuality(revision: number, changes: Change[], contentHash: string, includedChangeKeys: string[], baselineSnapshotID: string | undefined, baselineSequence: number) { return { checks: [{ name: 'deterministic-readiness', status: 'passed' }], proof: { revision, changeHash: changeSetHash(changes), contentHash, includedChangeKeys, baselineSnapshotID, baselineSequence, report: { publishable: true } } } }

function baseline() {
  const value = structuredClone(neutralFixture)
  const sectionID = randomUUID(); const pageID = randomUUID()
  const suffix = sectionID.slice(0, 8)
  value.settings.homepageId = pageID
  value.settings.sections[0]!.id = sectionID; value.settings.sections[0]!.pageIds = [pageID]; value.settings.sections[0]!.slug = `general-${suffix}`
  value.pages[0]!.id = pageID; value.pages[0]!.sectionId = sectionID; value.pages[0]!.slug = `welcome-${suffix}`
  return value
}

async function fixture(label: string, options: { preview?: 'ready' | 'pending'; excluded?: boolean } = {}) {
  const reviewer = await payload.create({ collection: 'users', data: { email: `${label}-reviewer@example.test`, name: 'Reviewer', roles: ['approver'] }, overrideAccess: true })
  const editor = await payload.create({ collection: 'users', data: { email: `${label}-editor@example.test`, name: 'Editor', roles: ['editor'] }, overrideAccess: true })
  const currentBase = baseline(); const section = currentBase.settings.sections[0]!; const page = currentBase.pages[0]!
  await payload.create({ collection: 'sections', data: { id: section.id, name: section.name, summary: section.summary, slug: section.slug, allowedTemplates: section.allowedTemplates, pageIds: [] }, draft: true, overrideAccess: true })
  await payload.create({ collection: 'pages', data: { id: page.id, sectionId: page.sectionId, title: page.title, summary: page.summary, slug: page.slug, template: page.template, blocks: page.blocks }, overrideAccess: true })
  const after = { ...page, title: `Approved ${label}`, status: undefined }
  delete (after as { status?: unknown }).status
  const before = { ...page, status: undefined }
  delete (before as { status?: unknown }).status
  const changes: Change[] = [{ collection: 'pages', id: page.id, before, after, beforeHash: canonicalHash(before), afterHash: null }]
  if (options.excluded) changes.push({ collection: 'redirects', id: '/remaining', before: null, after: { from: '/remaining', to: '/welcome', status: 301 }, beforeHash: null, afterHash: null })
  const included = [`pages:${page.id}`]
  const set = await payload.create({ collection: 'change-sets', data: { name: label, actor: editor.id, state: 'submitted', revision: 4, changes, quality: { checks: [{ name: 'contract-and-tree', status: 'passed' }] }, preview: { status: 'pending' } }, overrideAccess: true, context: { editorialInternal: true } })
  const persistedChanges = set.changes as Change[]
  const candidate = buildCandidate(currentBase, persistedChanges, included, versions)
  const preview = options.preview === 'pending' ? { status: 'pending' } : { status: 'ready', revision: 4, changeHash: changeSetHash(persistedChanges), includedChangeKeys: included, contentHash: canonicalHash(candidate), baselineSequence: 0 }
  const reviewed = await payload.update({ collection: 'change-sets', id: set.id, data: { preview, quality: options.preview === 'pending' ? { checks: [{ name: 'contract-and-tree', status: 'passed' }] } : passingQuality(4, persistedChanges, canonicalHash(candidate), included, undefined, 0) }, overrideAccess: true, context: { editorialInternal: true } })
  const token = newOpaqueToken()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: reviewer.id, authenticatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  return { reviewer, editor, set: reviewed, changes: persistedChanges, included, candidate, baseline: currentBase, headers: new Headers({ cookie: `site_engine_session=${token}` }) }
}
async function approve(current: Awaited<ReturnType<typeof fixture>>, initialBaseline = current.baseline) {
  return withPayloadTransaction(payload, req => { req.headers = current.headers; return approveChangeSet({ payload, req, actor: current.reviewer, id: current.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(current.changes), includedChangeKeys: current.included, previewContentHash: canonicalHash(current.candidate), versions, initialBaseline }) })
}
async function schedule(current: Awaited<ReturnType<typeof fixture>>, scheduledFor: string, initialBaseline = current.baseline) {
  return withPayloadTransaction(payload, req => { req.headers = current.headers; return approveChangeSet({ payload, req, actor: current.reviewer, id: current.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(current.changes), includedChangeKeys: current.included, previewContentHash: canonicalHash(current.candidate), versions, initialBaseline, scheduledFor }) })
}

async function ownerSession(label: string, freshAt = new Date()) {
  const owner = await payload.create({ collection: 'users', data: { email: `${label}-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
  const token = newOpaqueToken(); const now = new Date()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: owner.id, authenticatedAt: freshAt.toISOString(), lastSeenAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() }, overrideAccess: true })
  return { owner, headers: new Headers({ cookie: `site_engine_session=${token}` }) }
}

async function installPublishedBaseline(current: Awaited<ReturnType<typeof fixture>>) {
  const snapshot = await payload.create({ collection: 'publish-snapshots', data: { changeSet: current.set.id, reviewRevision: 0, changeHash: 'baseline', contentHash: canonicalHash(current.baseline), manifest: current.baseline, themeVersion: versions.themeVersion, engineVersion: versions.engineVersion, contractVersion: versions.contractVersion, approvedBy: current.reviewer.id, baselineSequence: 0 }, overrideAccess: true, context: { editorialInternal: true } })
  const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: `baseline:${snapshot.id}`, sequence: 1, snapshot: snapshot.id, changeSet: current.set.id, reviewRevision: 0, changeHash: 'baseline', includedChangeKeys: [], status: 'completed', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence: 1, snapshot: snapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { status: 'healthy' }, artifact: artifact(snapshot.contentHash) }, overrideAccess: true, context: { editorialInternal: true } })
  return { snapshot, sequence: 1 }
}

function artifact(sourceContentHash: string) { return { digest: 'a'.repeat(64), sourceContentHash, ...versions, checks: [{ name: 'artifact-integrity', status: 'passed' as const }, { name: 'public-health', status: 'passed' as const }] } }

async function bindPreview(current: Awaited<ReturnType<typeof fixture>>, base: ReturnType<typeof baseline>, baselineSnapshotID?: string, baselineSequence = 0) {
  const candidate = buildCandidate(base, current.changes, current.included, versions)
  await payload.update({ collection: 'change-sets', id: current.set.id, data: { preview: { status: 'ready', revision: 4, changeHash: changeSetHash(current.changes), includedChangeKeys: current.included, contentHash: canonicalHash(candidate), baselineSnapshotID, baselineSequence }, quality: passingQuality(4, current.changes, canonicalHash(candidate), current.included, baselineSnapshotID, baselineSequence) }, overrideAccess: true, context: { editorialInternal: true } })
  return candidate
}

async function prepareRedirectApproval(current: Awaited<ReturnType<typeof fixture>>, base: ReturnType<typeof baseline>, baselineSnapshotID: string | undefined, baselineSequence: number, path: string) {
  const changes: Change[] = [{ collection: 'redirects', id: path, before: null, after: { from: path, to: '/welcome', status: 301 }, beforeHash: null, afterHash: null }]
  const included = [`redirects:${path}`]
  const candidate = buildCandidate(base, changes, included, versions)
  await payload.update({ collection: 'change-sets', id: current.set.id, data: { changes, preview: { status: 'ready', revision: 4, changeHash: changeSetHash(changes), includedChangeKeys: included, contentHash: canonicalHash(candidate), baselineSnapshotID, baselineSequence }, quality: passingQuality(4, changes, canonicalHash(candidate), included, baselineSnapshotID, baselineSequence) }, overrideAccess: true, context: { editorialInternal: true } })
  return { changes, included, candidate }
}

describe('ENG-029 immutable approval snapshots and durable publish outbox', () => {
  it('freezes a future approved release without advancing or exposing the publish queue, and retries exactly once', async () => {
    const current = await fixture('scheduled')
    const published = await installPublishedBaseline(current)
    await bindPreview(current, current.baseline, published.snapshot.id, published.sequence)
    const scheduledFor = '2030-01-02T03:04:05.000Z'
    const result = await schedule(current, scheduledFor)
    expect(result).toMatchObject({ scheduledFor, outboxID: undefined })
    expect(result.scheduledPublicationID).toEqual(expect.any(String))
    const scheduledPublication = await payload.findByID({ collection: 'scheduled-publications', id: result.scheduledPublicationID!, depth: 1, overrideAccess: true })
    expect(scheduledPublication).toMatchObject({ state: 'scheduled', scheduledFor, changeSet: expect.objectContaining({ id: current.set.id }), idempotencyKey: result.idempotencyKey })
    expect(scheduledPublication.proof).toMatchObject({ changeHash: changeSetHash(current.changes), reviewRevision: 4, previewContentHash: canonicalHash(current.candidate), includedChangeKeys: current.included })
    expect((await payload.find({ collection: 'publish-outbox', sort: '-sequence', overrideAccess: true })).docs).toHaveLength(1)
    expect(await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req))).toBeNull()
    expect(await schedule(current, scheduledFor)).toEqual(result)
    expect((await payload.count({ collection: 'scheduled-publications', overrideAccess: true })).totalDocs).toBe(1)
    await expect(schedule(current, '2030-01-02T03:04:06.000Z')).rejects.toThrow('persisted snapshot')
  })

  it('rejects non-UTC or elapsed schedules and users without an approval role', async () => {
    const current = await fixture('scheduled-invalid')
    expect(() => scheduledPublicationTime('2030-01-02T03:04:05+01:00')).toThrow('UTC ISO')
    expect(() => scheduledPublicationTime('2020-01-02T03:04:05.000Z')).toThrow('future')
    await expect(schedule(current, '2020-01-02T03:04:05.000Z')).rejects.toThrow('future')
    await payload.update({ collection: 'users', id: current.reviewer.id, data: { roles: ['editor'] }, overrideAccess: true })
    await expect(schedule(current, '2030-01-02T03:04:05.000Z')).rejects.toThrow('Reviewer role')
    expect((await payload.count({ collection: 'scheduled-publications', overrideAccess: true })).totalDocs).toBe(0)
  })

  it('dispatches only due schedules once, after preserving immediate queue ordering', async () => {
    const current = await fixture('dispatch-due')
    const published = await installPublishedBaseline(current)
    await bindPreview(current, current.baseline, published.snapshot.id, published.sequence)
    const scheduled = await schedule(current, '2030-01-02T03:04:05.000Z')
    const beforeDue = await withPayloadTransaction(payload, req => dispatchDueScheduledPublications(payload, req, new Date('2030-01-02T03:04:04.999Z')))
    expect(beforeDue).toEqual({ enqueued: 0, skipped: 0 })
    const due = await withPayloadTransaction(payload, req => dispatchDueScheduledPublications(payload, req, new Date('2030-01-02T03:04:05.000Z')))
    expect(due).toEqual({ enqueued: 1, skipped: 0 })
    expect(await withPayloadTransaction(payload, req => dispatchDueScheduledPublications(payload, req, new Date('2030-01-02T03:04:06.000Z')))).toEqual({ enqueued: 0, skipped: 0 })
    const record = await payload.findByID({ collection: 'scheduled-publications', id: scheduled.scheduledPublicationID!, depth: 1, overrideAccess: true })
    expect(record).toMatchObject({ state: 'enqueued', outbox: expect.objectContaining({ sequence: 2 }) })
    expect((await payload.find({ collection: 'audit-events', where: { event: { equals: 'editorial.scheduled_publication_enqueued' } }, overrideAccess: true })).docs).toHaveLength(1)
    const owner = await ownerSession('post-enqueue-owner')
    await expect(withPayloadTransaction(payload, req => { req.headers = owner.headers; return cancelScheduledPublication({ payload, req, actor: owner.owner, id: scheduled.scheduledPublicationID! }) })).rejects.toThrow('Only a scheduled publication')
    await expect(withPayloadTransaction(payload, req => { req.headers = owner.headers; return reschedulePublication({ payload, req, actor: owner.owner, id: scheduled.scheduledPublicationID!, scheduledFor: '2030-01-02T04:04:05.000Z' }) })).rejects.toThrow('Only a scheduled publication')
    const job = await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req, new Date('2030-01-02T03:04:06.000Z')))
    expect(job).toMatchObject({ id: (record.outbox as { id: string }).id, sequence: 2 })
    expect((await payload.find({ collection: 'publish-outbox', overrideAccess: true })).docs).toHaveLength(2)
  })

  it('marks a due schedule stale when an intervening publication changes its queue baseline', async () => {
    const current = await fixture('dispatch-stale')
    const published = await installPublishedBaseline(current)
    await bindPreview(current, current.baseline, published.snapshot.id, published.sequence)
    const scheduled = await schedule(current, '2030-01-02T03:04:05.000Z')
    const intervening = await fixture('dispatch-intervening')
    const prepared = await prepareRedirectApproval(intervening, current.baseline, published.snapshot.id, published.sequence, '/intervening')
    await withPayloadTransaction(payload, req => { req.headers = intervening.headers; return approveChangeSet({ payload, req, actor: intervening.reviewer, id: intervening.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(prepared.changes), includedChangeKeys: prepared.included, previewContentHash: canonicalHash(prepared.candidate), versions, initialBaseline: current.baseline }) })
    expect(await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req))).toMatchObject({ sequence: 2 })
    expect(await withPayloadTransaction(payload, req => dispatchDueScheduledPublications(payload, req, new Date('2030-01-02T03:04:05.000Z')))).toEqual({ enqueued: 0, skipped: 1 })
    expect(await payload.findByID({ collection: 'scheduled-publications', id: scheduled.scheduledPublicationID!, overrideAccess: true })).toMatchObject({ state: 'stale', dispatchReason: 'BASELINE_STALE' })
    expect(await payload.findByID({ collection: 'change-sets', id: current.set.id, overrideAccess: true })).toMatchObject({ state: 'changes-requested', revision: Number(current.set.revision) + 1 })
    expect((await payload.find({ collection: 'audit-events', where: { event: { equals: 'editorial.scheduled_publication_skipped' } }, overrideAccess: true })).docs).toHaveLength(1)
  })

  it('marks a due schedule stale when its approving user is revoked or disabled', async () => {
    const current = await fixture('dispatch-revoked')
    const published = await installPublishedBaseline(current)
    await bindPreview(current, current.baseline, published.snapshot.id, published.sequence)
    const scheduled = await schedule(current, '2030-01-02T03:04:05.000Z')
    await payload.update({ collection: 'users', id: current.reviewer.id, data: { disabled: true }, overrideAccess: true })
    expect(await withPayloadTransaction(payload, req => dispatchDueScheduledPublications(payload, req, new Date('2030-01-02T03:04:05.000Z')))).toEqual({ enqueued: 0, skipped: 1 })
    expect(await payload.findByID({ collection: 'scheduled-publications', id: scheduled.scheduledPublicationID!, overrideAccess: true })).toMatchObject({ state: 'stale', dispatchReason: 'APPROVAL_AUTHORITY_REVOKED' })
    expect(await payload.findByID({ collection: 'change-sets', id: current.set.id, overrideAccess: true })).toMatchObject({ state: 'changes-requested', revision: Number(current.set.revision) + 1 })
  })

  it('lets only a fresh owner cancel or reschedule a pre-enqueue schedule through the same-origin API', async () => {
    const current = await fixture('schedule-owner-api')
    const published = await installPublishedBaseline(current)
    await bindPreview(current, current.baseline, published.snapshot.id, published.sequence)
    const first = await schedule(current, '2030-01-02T03:04:05.000Z')
    const owner = await ownerSession('schedule-owner')
    const request = (action: string, body: object, headers = owner.headers) => scheduledPublicationRoute.POST(new Request(`http://cms.test/api/editorial/schedules/${action}`, { method: 'POST', headers: { origin: 'http://cms.test', 'content-type': 'application/json', cookie: headers.get('cookie')! }, body: JSON.stringify(body) }), { params: Promise.resolve({ action }) })
    expect((await request('reschedule', { id: first.scheduledPublicationID, scheduledFor: '2030-01-02T05:04:05.000Z' }, current.headers)).status).toBe(403)
    const staleOwner = await ownerSession('schedule-stale-owner', new Date(Date.now() - 15 * 60_000 - 1))
    expect((await request('cancel', { id: first.scheduledPublicationID }, staleOwner.headers)).status).toBe(403)
    const rescheduled = await request('reschedule', { id: first.scheduledPublicationID, scheduledFor: '2030-01-02T04:04:05.000Z' })
    expect(rescheduled.status).toBe(200)
    expect(await rescheduled.json()).toMatchObject({ state: 'scheduled', scheduledFor: '2030-01-02T04:04:05.000Z' })
    expect((await request('cancel', { id: first.scheduledPublicationID })).status).toBe(200)
    expect(await payload.findByID({ collection: 'scheduled-publications', id: first.scheduledPublicationID!, overrideAccess: true })).toMatchObject({ state: 'cancelled', dispatchReason: 'CANCELLED_BY_OWNER' })
    expect(await payload.findByID({ collection: 'change-sets', id: current.set.id, overrideAccess: true })).toMatchObject({ state: 'changes-requested', revision: Number(current.set.revision) + 1 })
    expect((await scheduledPublicationRoute.POST(new Request('http://cms.test/api/editorial/schedules/cancel', { method: 'POST', headers: { origin: 'http://cms.test', 'content-type': 'application/json' }, body: JSON.stringify({ id: first.scheduledPublicationID }) }), { params: Promise.resolve({ action: 'cancel' }) })).status).toBe(401)
  })

  it('uses a contract-valid frozen candidate, preserves exclusions, and deduplicates retry', async () => {
    const current = await fixture('approved', { excluded: true })
    const published = await installPublishedBaseline(current)
    await bindPreview(current, current.baseline, published.snapshot.id, published.sequence)
    const untrustedBaseline = structuredClone(current.baseline)
    untrustedBaseline.settings.siteName = 'Untrusted baseline must not win'
    const result = await approve(current, untrustedBaseline)
    const snapshot = await payload.findByID({ collection: 'publish-snapshots', id: result.snapshotID!, overrideAccess: true })
    expect(canonicalHash(snapshot.manifest)).toBe(snapshot.contentHash)
    expect((snapshot.manifest as typeof current.baseline).redirects).toEqual([])
    expect((snapshot.manifest as typeof current.baseline).settings).toEqual(current.baseline.settings)
    expect((snapshot.manifest as typeof current.baseline).media).toEqual(current.baseline.media)
    expect(snapshot).toMatchObject({ themeVersion: versions.themeVersion, engineVersion: versions.engineVersion })
    const remaining = await payload.find({ collection: 'change-sets', where: { actor: { equals: current.editor.id } }, overrideAccess: true })
    expect(remaining.docs.find((set) => set.id !== current.set.id)?.changes).toHaveLength(1)
    const repeat = await approve(current)
    expect(repeat).toEqual(result)
    await expect(withPayloadTransaction(payload, req => { req.headers = current.headers; return approveChangeSet({ payload, req, actor: current.reviewer, id: current.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(current.changes), includedChangeKeys: [...current.included, ...current.included], previewContentHash: canonicalHash(current.candidate), versions, initialBaseline: current.baseline }) })).rejects.toThrow('unique')
    await expect(withPayloadTransaction(payload, req => { req.headers = current.headers; return approveChangeSet({ payload, req, actor: current.reviewer, id: current.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(current.changes), includedChangeKeys: current.included, previewContentHash: canonicalHash(current.candidate), versions: { ...versions, themeVersion: 'forged-version' }, initialBaseline: current.baseline }) })).rejects.toThrow('persisted snapshot')
    expect((await payload.count({ collection: 'publish-snapshots', overrideAccess: true })).totalDocs).toBe(2)
    expect((await payload.count({ collection: 'publish-outbox', overrideAccess: true })).totalDocs).toBe(2)
    await expect(payload.update({ collection: 'publish-snapshots', id: snapshot.id, data: { themeVersion: 'forged' }, user: current.reviewer, overrideAccess: false })).rejects.toThrow('not allowed')
    await expect(payload.delete({ collection: 'publish-snapshots', id: snapshot.id, user: current.reviewer, overrideAccess: false })).rejects.toThrow('not allowed')
  })

  it('rejects mismatched preview, duplicate selection, stale content, and canonical-role revocation', async () => {
    const pending = await fixture('pending', { preview: 'pending' })
    await expect(approve(pending)).rejects.toThrow('exact candidate')
    const duplicate = await fixture('duplicate')
    await expect(withPayloadTransaction(payload, req => { req.headers = duplicate.headers; return approveChangeSet({ payload, req, actor: duplicate.reviewer, id: duplicate.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(duplicate.changes), includedChangeKeys: [...duplicate.included, ...duplicate.included], previewContentHash: canonicalHash(duplicate.candidate), versions, initialBaseline: duplicate.baseline }) })).rejects.toThrow('unique')
    const stale = await fixture('stale')
    await payload.create({ collection: 'sections', data: { name: 'Unrelated', summary: 'A valid unrelated draft write makes the set stale only when its record changes.', slug: 'unrelated', allowedTemplates: ['standard'] }, overrideAccess: true })
    await payload.update({ collection: 'pages', id: stale.changes[0]!.id, data: { title: 'Edited after review' }, draft: true, overrideAccess: true }).catch(() => undefined)
    await payload.update({ collection: 'change-sets', id: stale.set.id, data: { state: 'stale' }, overrideAccess: true, context: { editorialInternal: true } })
    await expect(approve(stale)).rejects.toThrow(/stale|exact candidate/)
    const revoked = await fixture('revoked')
    await payload.update({ collection: 'users', id: revoked.reviewer.id, data: { roles: ['editor'] }, overrideAccess: true })
    await expect(approve(revoked)).rejects.toThrow('Reviewer role')
  })

  it('removes the old redirect key when an included redirect is renamed', () => {
    const base = baseline()
    base.redirects = [{ from: '/old-path', to: '/welcome', status: 301 }]
    const before = { from: '/old-path', to: '/welcome', status: 301 }
    const candidate = buildCandidate(base, [{ collection: 'redirects', id: '/old-path', before, after: { from: '/new-path', to: '/welcome', status: 301 }, beforeHash: canonicalHash(before), afterHash: null }], ['redirects:/old-path'], versions)
    expect(candidate.redirects).toEqual([{ from: '/new-path', to: '/welcome', status: 301 }])
  })

  it('preserves different queued fields and rejects an overlapping same-field approval', () => {
    const base = baseline()
    const page = base.pages[0]!
    const before = { ...page, status: undefined }
    delete (before as { status?: unknown }).status
    const first: Change = { collection: 'pages', id: page.id, before, after: { ...before, title: 'Queued title' }, beforeHash: canonicalHash(before), afterHash: null }
    const firstCandidate = buildCandidate(base, [first], [`pages:${page.id}`], versions)
    const second: Change = { collection: 'pages', id: page.id, before, after: { ...before, summary: 'Queued summary' }, beforeHash: canonicalHash(before), afterHash: null }
    const composed = buildCandidate(firstCandidate, [second], [`pages:${page.id}`], versions)
    expect(composed.pages[0]).toMatchObject({ title: 'Queued title', summary: 'Queued summary' })
    const conflict: Change = { collection: 'pages', id: page.id, before, after: { ...before, title: 'Conflicting title' }, beforeHash: canonicalHash(before), afterHash: null }
    expect(() => buildCandidate(firstCandidate, [conflict], [`pages:${page.id}`], versions)).toThrow('conflicts with the queued baseline')
  })

  it('keeps separate immutable snapshot versions when their content is identical', async () => {
    const current = await fixture('identical-content')
    const data = { changeSet: current.set.id, reviewRevision: 4, changeHash: 'same-content-different-version', contentHash: canonicalHash(current.baseline), manifest: current.baseline, themeVersion: versions.themeVersion, engineVersion: versions.engineVersion, contractVersion: versions.contractVersion, approvedBy: current.reviewer.id, baselineSequence: 0 }
    const first = await payload.create({ collection: 'publish-snapshots', data, overrideAccess: true, context: { editorialInternal: true } })
    const second = await payload.create({ collection: 'publish-snapshots', data, overrideAccess: true, context: { editorialInternal: true } })
    expect(second.id).not.toBe(first.id)
    expect(second.contentHash).toBe(first.contentHash)
  })

  it('serializes the SQLite worker head across leases, crash recovery, and backoff', async () => {
    const first = await fixture('lease-first')
    const second = await fixture('lease-second')
    await approve(first)
    const firstJob = await payload.find({ collection: 'publish-outbox', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true })
    const firstSnapshot = firstJob.docs[0]!.snapshot as unknown as { id: string; manifest: ReturnType<typeof baseline> }
    const prepared = await prepareRedirectApproval(second, firstSnapshot.manifest, firstSnapshot.id, 1, '/lease-second')
    await withPayloadTransaction(payload, req => { req.headers = second.headers; return approveChangeSet({ payload, req, actor: second.reviewer, id: second.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(prepared.changes), includedChangeKeys: prepared.included, previewContentHash: canonicalHash(prepared.candidate), versions, initialBaseline: second.baseline }) })
    const started = new Date('2026-10-03T15:05:00.000Z')
    const lease = await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req, started, 1_000))
    expect(typeof lease?.changeSet === 'object' ? lease.changeSet.id : lease?.changeSet).toBe(first.set.id)
    expect(await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req, started, 1_000))).toBeNull()
    await expect(withPayloadTransaction(payload, req => retryPublishJob(payload, req, String(lease!.id), 'stale-lease', 'BUILD_TIMEOUT', new Date(started.getTime() + 1)))).rejects.toThrow('no longer current')
    const reclaimedAt = new Date(started.getTime() + 1_001)
    const reclaimed = await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req, reclaimedAt, 1_000))
    expect(reclaimed).toMatchObject({ id: lease!.id, attempts: 2 })
    expect(reclaimed?.leaseToken).not.toBe(lease?.leaseToken)
    const renewed = await withPayloadTransaction(payload, req => renewPublishLease(payload, req, String(reclaimed!.id), String(reclaimed!.leaseToken), reclaimedAt, 1_000))
    expect(new Date(String(renewed.leaseExpiresAt)).getTime()).toBe(reclaimedAt.getTime() + 1_000)
    await withPayloadTransaction(payload, req => retryPublishJob(payload, req, String(reclaimed!.id), String(reclaimed!.leaseToken), 'BUILD_TIMEOUT', reclaimedAt))
    expect(await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req, new Date(reclaimedAt.getTime() + 999), 1_000))).toBeNull()
    const finalLease = await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req, new Date(reclaimedAt.getTime() + 2_000), 1_000))
    expect(finalLease).toMatchObject({ id: lease!.id, attempts: 3 })
    const snapshot = typeof finalLease!.snapshot === 'object' ? finalLease!.snapshot : await payload.findByID({ collection: 'publish-snapshots', id: String(finalLease!.snapshot), overrideAccess: true })
    await withPayloadTransaction(payload, req => completePublishJob(payload, req, String(finalLease!.id), String(finalLease!.leaseToken), artifact(snapshot.contentHash), new Date(reclaimedAt.getTime() + 2_001)))
    expect(await payload.findByID({ collection: 'change-sets', id: first.set.id, overrideAccess: true })).toMatchObject({ state: 'published' })
  })

  it('composes queued approvals from the queue head and rejects previews for an older baseline', async () => {
    const first = await fixture('queue-first')
    const second = await fixture('queue-second')
    const firstResult = await approve(first)
    const firstSnapshot = await payload.findByID({ collection: 'publish-snapshots', id: firstResult.snapshotID!, overrideAccess: true })
    const redirectChange: Change = { collection: 'redirects', id: '/queue-proof', before: null, after: { from: '/queue-proof', to: '/welcome', status: 301 }, beforeHash: null, afterHash: null }
    const secondChanges = [redirectChange]
    await payload.update({ collection: 'change-sets', id: second.set.id, data: { changes: secondChanges, preview: { status: 'ready', revision: 4, changeHash: changeSetHash(secondChanges), includedChangeKeys: ['redirects:/queue-proof'], contentHash: canonicalHash(buildCandidate(second.baseline, secondChanges, ['redirects:/queue-proof'], versions)), baselineSequence: 0 } }, overrideAccess: true, context: { editorialInternal: true } })
    await expect(withPayloadTransaction(payload, req => { req.headers = second.headers; return approveChangeSet({ payload, req, actor: second.reviewer, id: second.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(secondChanges), includedChangeKeys: ['redirects:/queue-proof'], previewContentHash: canonicalHash(buildCandidate(second.baseline, secondChanges, ['redirects:/queue-proof'], versions)), versions, initialBaseline: second.baseline }) })).rejects.toThrow('exact baseline')
    const queuedCandidate = buildCandidate(firstSnapshot.manifest as ReturnType<typeof baseline>, secondChanges, ['redirects:/queue-proof'], versions)
    await payload.update({ collection: 'change-sets', id: second.set.id, data: { preview: { status: 'ready', revision: 4, changeHash: changeSetHash(secondChanges), includedChangeKeys: ['redirects:/queue-proof'], contentHash: canonicalHash(queuedCandidate), baselineSnapshotID: firstSnapshot.id, baselineSequence: 1 }, quality: passingQuality(4, secondChanges, canonicalHash(queuedCandidate), ['redirects:/queue-proof'], firstSnapshot.id, 1) }, overrideAccess: true, context: { editorialInternal: true } })
    const secondResult = await withPayloadTransaction(payload, req => { req.headers = second.headers; return approveChangeSet({ payload, req, actor: second.reviewer, id: second.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(secondChanges), includedChangeKeys: ['redirects:/queue-proof'], previewContentHash: canonicalHash(queuedCandidate), versions, initialBaseline: second.baseline }) })
    const secondSnapshot = await payload.findByID({ collection: 'publish-snapshots', id: secondResult.snapshotID!, overrideAccess: true })
    expect((secondSnapshot.manifest as ReturnType<typeof baseline>).pages).toEqual((firstSnapshot.manifest as ReturnType<typeof baseline>).pages)
    expect((secondSnapshot.manifest as ReturnType<typeof baseline>).redirects).toContainEqual({ from: '/queue-proof', to: '/welcome', status: 301 })
    const baselineSnapshotID = secondSnapshot.baselineSnapshot && typeof secondSnapshot.baselineSnapshot === 'object' ? secondSnapshot.baselineSnapshot.id : secondSnapshot.baselineSnapshot
    expect(baselineSnapshotID).toBe(firstSnapshot.id)
    expect(secondSnapshot.baselineSequence).toBe(1)
  })

  it('turns an expired final lease into a terminal failure and accepts only named health checks', async () => {
    const current = await fixture('terminal-lease')
    await approve(current)
    const started = new Date('2026-10-03T16:00:00.000Z')
    const lease = await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req, started, 1_000, 1))
    expect(await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req, new Date(started.getTime() + 1_001), 1_000, 1))).toBeNull()
    const failed = await payload.findByID({ collection: 'publish-outbox', id: String(lease!.id), overrideAccess: true })
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'LEASE_EXPIRED', attempts: 1 })
    const other = await fixture('invalid-health')
    const failedSnapshot = typeof failed.snapshot === 'object' ? failed.snapshot as unknown as { id: string; manifest: ReturnType<typeof baseline> } : await payload.findByID({ collection: 'publish-snapshots', id: String(failed.snapshot), overrideAccess: true }) as unknown as { id: string; manifest: ReturnType<typeof baseline> }
    const prepared = await prepareRedirectApproval(other, failedSnapshot.manifest, failedSnapshot.id, 1, '/invalid-health')
    await withPayloadTransaction(payload, req => { req.headers = other.headers; return approveChangeSet({ payload, req, actor: other.reviewer, id: other.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(prepared.changes), includedChangeKeys: prepared.included, previewContentHash: canonicalHash(prepared.candidate), versions, initialBaseline: other.baseline }) })
    const validLease = await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req, new Date(started.getTime() + 2_000)))
    const snapshot = typeof validLease!.snapshot === 'object' ? validLease!.snapshot : await payload.findByID({ collection: 'publish-snapshots', id: String(validLease!.snapshot), overrideAccess: true })
    await expect(withPayloadTransaction(payload, req => completePublishJob(payload, req, String(validLease!.id), String(validLease!.leaseToken), { ...artifact(snapshot.contentHash), checks: [{ name: 'anything', status: 'passed' }] }, new Date(started.getTime() + 2_001)))).rejects.toThrow('Verified artifact')
  })

  it('rolls back snapshots/outbox and keeps delivery outside a claim/retry transaction', async () => {
    const current = await fixture('rollback')
    await expect(withPayloadTransaction(payload, async req => { req.headers = current.headers; await approveChangeSet({ payload, req, actor: current.reviewer, id: current.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(current.changes), includedChangeKeys: current.included, previewContentHash: canonicalHash(current.candidate), versions, initialBaseline: current.baseline }); throw new Error('rollback') })).rejects.toThrow('rollback')
    const approved = await fixture('worker')
    await approve(approved)
    const job = await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req))
    expect(job?.status).toBe('processing')
    const retryAt = new Date()
    await withPayloadTransaction(payload, req => retryPublishJob(payload, req, String(job!.id), String(job!.leaseToken), 'BUILD_TIMEOUT', retryAt))
    const second = await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req, new Date(retryAt.getTime() + 1_000)))
    expect(second).toMatchObject({ id: job!.id, attempts: 2 })
    const snapshot = typeof second!.snapshot === 'object' ? second!.snapshot : await payload.findByID({ collection: 'publish-snapshots', id: String(second!.snapshot), overrideAccess: true })
    const completed = await withPayloadTransaction(payload, req => completePublishJob(payload, req, String(second!.id), String(second!.leaseToken), artifact(snapshot.contentHash), new Date(retryAt.getTime() + 1_001)))
    expect(await withPayloadTransaction(payload, req => completePublishJob(payload, req, String(second!.id), 'replayed-token', artifact(snapshot.contentHash), new Date(retryAt.getTime() + 1_002)))).toMatchObject({ id: completed.id })
  })
})
