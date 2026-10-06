import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import type { SiteSnapshot } from '@site-engine/contract'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { withPayloadTransaction } from '../src/auth-transaction'
import { approveChangeSet, buildCandidate, canonicalHash, changeSetHash } from '../src/publishing'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-publish-recovery-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-publish-recovery'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
const { default: config } = await import('../payload.config.js')
const operations = await import('../app/api/operations/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload.destroy(); rmSync(directory, { recursive: true, force: true }) })
afterEach(async () => {
  for (const collection of ['audit-events', 'published-releases', 'publish-outbox', 'publish-snapshots', 'change-sets', 'auth-sessions', 'pages', 'sections', 'users'] as const) await payload.delete({ collection, where: { id: { exists: true } }, overrideAccess: true, context: { editorialInternal: true, archiveInternal: true } })
})

async function reviewer(role: 'owner' | 'approver' | 'editor' = 'approver', fresh = true) {
  const user = await payload.create({ collection: 'users', data: { email: `${role}-${randomUUID()}@example.test`, name: role, roles: [role] }, overrideAccess: true })
  const token = newOpaqueToken(); const now = Date.now()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: new Date(now - (fresh ? 0 : 16 * 60_000)).toISOString(), lastSeenAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }, overrideAccess: true })
  return { user, headers: new Headers({ cookie: `${cookieName(SESSION_COOKIE)}=${token}`, origin: 'http://cms.test', 'content-type': 'application/json' }) }
}

async function failedJob(actorID: string, sequence = 1, status: 'failed' | 'pending' = 'failed') {
  const changes = [{ collection: 'pages', id: randomUUID(), before: null, after: { id: randomUUID(), title: 'Synthetic approved page' }, beforeHash: null, afterHash: null }]
  const changeHash = canonicalHash(changes)
  const contentHash = canonicalHash(neutralFixture)
  const includedChangeKeys = changes.map((change) => `${change.collection}:${change.id}`)
  const set = await payload.create({ collection: 'change-sets', data: { name: `Approved ${sequence}`, actor: actorID, state: 'approved', revision: 7, changes, quality: { proof: { revision: 7, changeHash, contentHash, includedChangeKeys } } }, overrideAccess: true, context: { editorialInternal: true } })
  const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash, changeSet: set.id, reviewRevision: 7, changeHash, manifest: neutralFixture, themeVersion: 'test', engineVersion: 'test', contractVersion: neutralFixture.settings.contractVersion, approvedBy: actorID, baselineSequence: Math.max(0, sequence - 1) }, overrideAccess: true, context: { editorialInternal: true } })
  const job = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: randomUUID(), sequence, snapshot: snapshot.id, changeSet: set.id, reviewRevision: 7, changeHash, includedChangeKeys, status, attempts: status === 'failed' ? 3 : 0, nextAttemptAt: new Date(Date.now() + 60_000).toISOString(), claimedAt: new Date().toISOString(), leaseToken: 'obsolete-lease', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), errorCode: status === 'failed' ? 'BUILD_FAILED' : undefined, lastError: status === 'failed' ? 'BUILD_FAILED' : undefined, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  return { set, snapshot, job }
}

async function seed(manifest: SiteSnapshot) {
  for (const section of manifest.settings.sections) await payload.create({ collection: 'sections', data: { id: section.id, name: section.name, summary: section.summary, slug: section.slug, allowedTemplates: section.allowedTemplates, pageIds: [] }, draft: true, overrideAccess: true })
  for (const page of manifest.pages) await payload.create({ collection: 'pages', data: { id: page.id, sectionId: page.sectionId, title: page.title, summary: page.summary, slug: page.slug, template: page.template, blocks: page.blocks }, draft: true, overrideAccess: true })
}

async function partiallyApprovedFailedJob(actor: Awaited<ReturnType<typeof reviewer>>) {
  const baseline = structuredClone(neutralFixture)
  const before = { ...structuredClone(baseline.pages[0]), status: undefined } as Record<string, unknown>
  delete before.status
  const after = { ...before, title: 'Selected approved page' }
  const draft = structuredClone(baseline); draft.pages[0] = after as typeof draft.pages[number]
  await seed(draft)
  const changes = [
    { collection: 'pages', id: before.id, before, after, beforeHash: canonicalHash(before), afterHash: null },
    { collection: 'redirects', id: '/not-selected', before: null, after: { from: '/not-selected', to: '/', status: 301 }, beforeHash: null, afterHash: null },
  ]
  const includedChangeKeys = [`pages:${before.id}`]
  const versions = { themeVersion: 'test', engineVersion: 'test', contractVersion: baseline.settings.contractVersion }
  const candidate = buildCandidate(baseline, changes as never, includedChangeKeys, versions)
  const set = await payload.create({ collection: 'change-sets', data: { name: 'Partial approval', actor: actor.user.id, state: 'submitted', revision: 7, changes, preview: { status: 'ready', revision: 7, changeHash: changeSetHash(changes), contentHash: canonicalHash(candidate), includedChangeKeys, baselineSequence: 0 }, quality: { checks: [{ name: 'deterministic-readiness', status: 'passed' }], proof: { revision: 7, changeHash: changeSetHash(changes), contentHash: canonicalHash(candidate), includedChangeKeys, baselineSequence: 0, report: { publishable: true } } } }, overrideAccess: true, context: { editorialInternal: true } })
  const approved = await withPayloadTransaction(payload, async (req) => { req.headers = actor.headers; return approveChangeSet({ payload, req, actor: actor.user, id: String(set.id), expectedRevision: 7, expectedChangeHash: changeSetHash(changes), includedChangeKeys, previewContentHash: canonicalHash(candidate), versions, initialBaseline: baseline }) })
  await payload.update({ collection: 'publish-outbox', id: approved.outboxID!, data: { status: 'failed', attempts: 3, errorCode: 'BUILD_FAILED', lastError: 'BUILD_FAILED', leaseToken: 'old-lease', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true, context: { editorialInternal: true } })
  return { set, job: await payload.findByID({ collection: 'publish-outbox', id: approved.outboxID!, depth: 0, overrideAccess: true }) }
}

async function retry(headers: Headers, publishJobID: string, extra: Record<string, unknown> = {}) {
  return operations.POST(new Request('http://cms.test/api/operations', { method: 'POST', headers, body: JSON.stringify({ action: 'retry-publish', publishJobID, ...extra }) }))
}

describe('ENG-010 reviewed publish recovery', () => {
  it('fresh Approver requeues only the latest failed immutable job without changing its approved context', async () => {
    const actor = await reviewer()
    const current = await partiallyApprovedFailedJob(actor)
    const snapshotID = String(current.job.snapshot)
    const immutable = await payload.findByID({ collection: 'publish-snapshots', id: snapshotID, depth: 0, overrideAccess: true })
    const response = await retry(actor.headers, String(current.job.id))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ job: { id: current.job.id, status: 'pending', sequence: 1 } })
    const job = await payload.findByID({ collection: 'publish-outbox', id: current.job.id, depth: 0, overrideAccess: true })
    expect(job).toMatchObject({ status: 'pending', attempts: 0, leaseToken: null, leaseExpiresAt: null, errorCode: null, lastError: null })
    expect(Date.parse(String(job.nextAttemptAt))).toBeLessThanOrEqual(Date.now())
    expect(await payload.findByID({ collection: 'publish-snapshots', id: snapshotID, depth: 0, overrideAccess: true })).toMatchObject({ approvedBy: immutable.approvedBy, reviewRevision: immutable.reviewRevision, changeHash: immutable.changeHash, contentHash: immutable.contentHash, manifest: immutable.manifest })
    expect(await payload.findByID({ collection: 'change-sets', id: current.set.id, depth: 0, overrideAccess: true })).toMatchObject({ state: 'approved', revision: 7 })
    const audit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'editorial.publish_retry_requested' } }, limit: 1, depth: 0, overrideAccess: true })
    expect(audit.docs[0]).toMatchObject({ actor: actor.user.id, detail: { publishJob: current.job.id, changeSet: current.set.id, snapshot: snapshotID, reviewer: actor.user.id, context: 'fresh_staff_recovery', priorAttempts: 3 } })
  })

  it('rejects stale, demoted, nonfailed, superseded, and payload-expanded retries without mutation', async () => {
    const stale = await reviewer('approver', false); const staleJob = await failedJob(String(stale.user.id))
    expect((await retry(stale.headers, String(staleJob.job.id))).status).toBe(400)
    expect((await payload.findByID({ collection: 'publish-outbox', id: staleJob.job.id, depth: 0, overrideAccess: true })).status).toBe('failed')

    const demoted = await reviewer(); const demotedJob = await failedJob(String(demoted.user.id), 2)
    await payload.update({ collection: 'users', id: demoted.user.id, data: { roles: ['editor'] }, overrideAccess: true })
    expect((await retry(demoted.headers, String(demotedJob.job.id))).status).toBe(403)
    expect((await payload.findByID({ collection: 'publish-outbox', id: demotedJob.job.id, depth: 0, overrideAccess: true })).status).toBe('failed')

    const actor = await reviewer(); const nonfailed = await failedJob(String(actor.user.id), 3, 'pending')
    expect((await retry(actor.headers, String(nonfailed.job.id))).status).toBe(400)
    expect((await payload.findByID({ collection: 'publish-outbox', id: nonfailed.job.id, depth: 0, overrideAccess: true })).status).toBe('pending')

    const superseded = await failedJob(String(actor.user.id), 4); const latest = await failedJob(String(actor.user.id), 5)
    expect((await retry(actor.headers, String(superseded.job.id))).status).toBe(400)
    expect((await payload.findByID({ collection: 'publish-outbox', id: superseded.job.id, depth: 0, overrideAccess: true })).status).toBe('failed')
    expect((await retry(actor.headers, String(superseded.job.id), { status: 'pending' })).status).toBe(400)

    await payload.update({ collection: 'publish-snapshots', id: latest.snapshot.id, data: { contentHash: 'tampered' }, overrideAccess: true, context: { editorialInternal: true } })
    expect((await retry(actor.headers, String(latest.job.id))).status).toBe(400)
    expect((await payload.findByID({ collection: 'publish-outbox', id: latest.job.id, depth: 0, overrideAccess: true })).status).toBe('failed')
  })
})
