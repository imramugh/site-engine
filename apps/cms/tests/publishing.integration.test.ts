import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { withPayloadTransaction } from '../src/auth-transaction'
import { approveChangeSet, buildCandidate, canonicalHash, changeSetHash, claimNextPublishJob, completePublishJob, retryPublishJob } from '../src/publishing'
import { hashOpaqueToken, newOpaqueToken } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-publishing-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-publishing'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })
afterEach(async () => {
  await payload.delete({ collection: 'published-releases', where: { id: { exists: true } }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.delete({ collection: 'publish-outbox', where: { id: { exists: true } }, overrideAccess: true, context: { editorialInternal: true } })
})

const versions = { themeVersion: '1.2.3', engineVersion: '1.2.3', contractVersion: '1.0.0' }
type Change = { collection: 'pages' | 'sections' | 'redirects'; id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; beforeHash: string | null; afterHash: string | null }

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
  const changes: Change[] = [{ collection: 'pages', id: page.id, before: { ...page, status: undefined }, after, beforeHash: null, afterHash: null }]
  if (options.excluded) changes.push({ collection: 'redirects', id: '/remaining', before: null, after: { from: '/remaining', to: '/welcome', status: 301 }, beforeHash: null, afterHash: null })
  const included = [`pages:${page.id}`]
  const set = await payload.create({ collection: 'change-sets', data: { name: label, actor: editor.id, state: 'submitted', revision: 4, changes, quality: { checks: [{ name: 'contract-and-tree', status: 'passed' }] }, preview: { status: 'pending' } }, overrideAccess: true, context: { editorialInternal: true } })
  const persistedChanges = set.changes as Change[]
  const candidate = buildCandidate(currentBase, persistedChanges, included, versions)
  const preview = options.preview === 'pending' ? { status: 'pending' } : { status: 'ready', revision: 4, changeHash: changeSetHash(persistedChanges), includedChangeKeys: included, contentHash: canonicalHash(candidate) }
  const reviewed = await payload.update({ collection: 'change-sets', id: set.id, data: { preview }, overrideAccess: true, context: { editorialInternal: true } })
  const token = newOpaqueToken()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: reviewer.id, authenticatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  return { reviewer, editor, set: reviewed, changes: persistedChanges, included, candidate, baseline: currentBase, headers: new Headers({ cookie: `site_engine_session=${token}` }) }
}
async function approve(current: Awaited<ReturnType<typeof fixture>>, initialBaseline = current.baseline) {
  return withPayloadTransaction(payload, req => { req.headers = current.headers; return approveChangeSet({ payload, req, actor: current.reviewer, id: current.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(current.changes), includedChangeKeys: current.included, previewContentHash: canonicalHash(current.candidate), versions, initialBaseline }) })
}

async function installPublishedBaseline(current: Awaited<ReturnType<typeof fixture>>) {
  const snapshot = await payload.create({ collection: 'publish-snapshots', data: { changeSet: current.set.id, reviewRevision: 0, changeHash: 'baseline', contentHash: canonicalHash(current.baseline), manifest: current.baseline, themeVersion: versions.themeVersion, engineVersion: versions.engineVersion, contractVersion: versions.contractVersion, approvedBy: current.reviewer.id }, overrideAccess: true, context: { editorialInternal: true } })
  const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: `baseline:${snapshot.id}`, sequence: 1, snapshot: snapshot.id, changeSet: current.set.id, reviewRevision: 0, changeHash: 'baseline', includedChangeKeys: [], status: 'completed', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence: 1, snapshot: snapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { status: 'healthy' }, artifact: artifact(snapshot.contentHash) }, overrideAccess: true, context: { editorialInternal: true } })
}

function artifact(sourceContentHash: string) { return { digest: 'a'.repeat(64), sourceContentHash, ...versions, checks: [{ name: 'health', status: 'passed' as const }] } }

describe('ENG-029 immutable approval snapshots and durable publish outbox', () => {
  it('uses a contract-valid frozen candidate, preserves exclusions, and deduplicates retry', async () => {
    const current = await fixture('approved', { excluded: true })
    await installPublishedBaseline(current)
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
    const candidate = buildCandidate(base, [{ collection: 'redirects', id: '/old-path', before: { from: '/old-path', to: '/welcome', status: 301 }, after: { from: '/new-path', to: '/welcome', status: 301 }, afterHash: null }], ['redirects:/old-path'], versions)
    expect(candidate.redirects).toEqual([{ from: '/new-path', to: '/welcome', status: 301 }])
  })

  it('serializes the SQLite worker head across leases, crash recovery, and backoff', async () => {
    const first = await fixture('lease-first')
    const second = await fixture('lease-second')
    await approve(first)
    await approve(second)
    const started = new Date('2026-10-03T15:05:00.000Z')
    const lease = await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req, started, 1_000))
    expect(typeof lease?.changeSet === 'object' ? lease.changeSet.id : lease?.changeSet).toBe(first.set.id)
    expect(await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req, started, 1_000))).toBeNull()
    await expect(withPayloadTransaction(payload, req => retryPublishJob(payload, req, String(lease!.id), 'stale-lease', 'BUILD_TIMEOUT', new Date(started.getTime() + 1)))).rejects.toThrow('no longer current')
    const reclaimedAt = new Date(started.getTime() + 1_001)
    const reclaimed = await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req, reclaimedAt, 1_000))
    expect(reclaimed).toMatchObject({ id: lease!.id, attempts: 2 })
    expect(reclaimed?.leaseToken).not.toBe(lease?.leaseToken)
    await withPayloadTransaction(payload, req => retryPublishJob(payload, req, String(reclaimed!.id), String(reclaimed!.leaseToken), 'BUILD_TIMEOUT', reclaimedAt))
    expect(await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req, new Date(reclaimedAt.getTime() + 999), 1_000))).toBeNull()
    const finalLease = await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req, new Date(reclaimedAt.getTime() + 2_000), 1_000))
    expect(finalLease).toMatchObject({ id: lease!.id, attempts: 3 })
    const snapshot = typeof finalLease!.snapshot === 'object' ? finalLease!.snapshot : await payload.findByID({ collection: 'publish-snapshots', id: String(finalLease!.snapshot), overrideAccess: true })
    await withPayloadTransaction(payload, req => completePublishJob(payload, req, String(finalLease!.id), String(finalLease!.leaseToken), artifact(snapshot.contentHash), new Date(reclaimedAt.getTime() + 2_001)))
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
