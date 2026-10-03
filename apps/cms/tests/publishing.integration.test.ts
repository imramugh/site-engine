import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { withPayloadTransaction } from '../src/auth-transaction'
import { approveChangeSet, canonicalHash, changeSetHash, claimNextPublishJob, retryPublishJob } from '../src/publishing'
import { hashOpaqueToken, newOpaqueToken } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-publishing-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-publishing'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

async function fixture(label: string, preview = 'ready') {
  const reviewer = await payload.create({ collection: 'users', data: { email: `${label}-reviewer@example.test`, name: 'Reviewer', roles: ['approver'] }, overrideAccess: true })
  const editor = await payload.create({ collection: 'users', data: { email: `${label}-editor@example.test`, name: 'Editor', roles: ['editor'] }, overrideAccess: true })
  const section = await payload.create({ collection: 'sections', data: { name: `${label} section`, summary: 'A section that supports an immutable publishing test page.', slug: `${label}-section`, allowedTemplates: ['standard'] }, overrideAccess: true })
  const after = { title: 'Included', slug: `${label}-page`, sectionId: section.id, summary: 'A captured document used only to verify immutable release candidates.', template: 'standard' as const, blocks: [] }
  const page = await payload.create({ collection: 'pages', data: after, overrideAccess: true })
  const change = { collection: 'pages', id: String(page.id), before: null, after, beforeHash: null, afterHash: canonicalHash(after) }
  const set = await payload.create({ collection: 'change-sets', data: { name: label, actor: editor.id, state: 'submitted', revision: 4, changes: [change], quality: { checks: [{ name: 'contract-and-tree', status: 'passed' }] }, preview: { status: preview } }, overrideAccess: true, context: { editorialInternal: true } })
  const token = newOpaqueToken()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: reviewer.id, authenticatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  return { reviewer, editor, set, change, headers: new Headers({ cookie: `site_engine_session=${token}` }) }
}
const versions = { themeVersion: 'theme-test', engineVersion: 'engine-test', contractVersion: 'contract-test' }

describe('ENG-029 immutable approval snapshots and durable publish outbox', () => {
  it('creates one immutable snapshot and outbox job without foreign pending drafts', async () => {
    const current = await fixture('approved')
    const foreign = await fixture('foreign')
    const changeHash = changeSetHash(current.set.changes)
    const result = await withPayloadTransaction(payload, req => { req.headers = current.headers; return approveChangeSet({ payload, req, actor: current.reviewer, id: current.set.id, expectedRevision: 4, expectedChangeHash: changeHash, includedChangeKeys: [`pages:${current.change.id}`], versions }) })
    const snapshot = await payload.findByID({ collection: 'publish-snapshots', id: result.snapshotID!, overrideAccess: true })
    const content = (snapshot.manifest as { content: { pages: Record<string, unknown> } }).content.pages
    expect(content[current.change.id]).toBeTruthy()
    expect(content[foreign.change.id]).toBeUndefined()
    expect(await payload.count({ collection: 'publish-outbox', overrideAccess: true })).toMatchObject({ totalDocs: 1 })
    await expect(withPayloadTransaction(payload, req => { req.headers = current.headers; return approveChangeSet({ payload, req, actor: current.reviewer, id: current.set.id, expectedRevision: 4, expectedChangeHash: changeHash, includedChangeKeys: [`pages:${current.change.id}`], versions }) })).rejects.toThrow('Cannot approve')
    expect((await payload.count({ collection: 'publish-snapshots', overrideAccess: true })).totalDocs).toBe(1)
    expect((await payload.count({ collection: 'publish-outbox', overrideAccess: true })).totalDocs).toBe(1)
    await expect(payload.update({ collection: 'publish-snapshots', id: snapshot.id, data: { themeVersion: 'forged' }, user: current.reviewer, overrideAccess: false })).rejects.toThrow('not allowed')
    await expect(payload.delete({ collection: 'publish-snapshots', id: snapshot.id, user: current.reviewer, overrideAccess: false })).rejects.toThrow('not allowed')
  })

  it('rejects pending previews, stale reviewed revisions, and non-fresh sessions', async () => {
    const pending = await fixture('pending', 'pending')
    await expect(withPayloadTransaction(payload, req => { req.headers = pending.headers; return approveChangeSet({ payload, req, actor: pending.reviewer, id: pending.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(pending.set.changes), includedChangeKeys: [`pages:${pending.change.id}`], versions }) })).rejects.toThrow('ready private preview')
    const stale = await fixture('stale')
    await expect(withPayloadTransaction(payload, req => { req.headers = stale.headers; return approveChangeSet({ payload, req, actor: stale.reviewer, id: stale.set.id, expectedRevision: 3, expectedChangeHash: changeSetHash(stale.set.changes), includedChangeKeys: [`pages:${stale.change.id}`], versions }) })).rejects.toThrow('reviewed revision')
    await payload.update({ collection: 'pages', id: stale.change.id, data: { title: 'Edited after review' }, draft: true, overrideAccess: true })
    await expect(withPayloadTransaction(payload, req => { req.headers = stale.headers; return approveChangeSet({ payload, req, actor: stale.reviewer, id: stale.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(stale.set.changes), includedChangeKeys: [`pages:${stale.change.id}`], versions }) })).rejects.toThrow('stale')
    const old = await fixture('old')
    const session = await payload.find({ collection: 'auth-sessions', where: { user: { equals: old.reviewer.id } }, limit: 1, overrideAccess: true })
    await payload.update({ collection: 'auth-sessions', id: session.docs[0]!.id, data: { authenticatedAt: new Date(Date.now() - 16 * 60_000).toISOString() }, overrideAccess: true })
    await expect(withPayloadTransaction(payload, req => { req.headers = old.headers; return approveChangeSet({ payload, req, actor: old.reviewer, id: old.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(old.set.changes), includedChangeKeys: [`pages:${old.change.id}`], versions }) })).rejects.toThrow('Fresh authentication')
  })

  it('rolls back approval writes and claims/retries a durable job without delivery work', async () => {
    const current = await fixture('rollback')
    await expect(withPayloadTransaction(payload, async req => { req.headers = current.headers; await approveChangeSet({ payload, req, actor: current.reviewer, id: current.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(current.set.changes), includedChangeKeys: [`pages:${current.change.id}`], versions }); throw new Error('rollback') })).rejects.toThrow('rollback')
    expect((await payload.count({ collection: 'publish-snapshots', overrideAccess: true })).totalDocs).toBe(1)
    const approved = await fixture('worker')
    await withPayloadTransaction(payload, req => { req.headers = approved.headers; return approveChangeSet({ payload, req, actor: approved.reviewer, id: approved.set.id, expectedRevision: 4, expectedChangeHash: changeSetHash(approved.set.changes), includedChangeKeys: [`pages:${approved.change.id}`], versions }) })
    const job = await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req))
    expect(job?.status).toBe('processing')
    await withPayloadTransaction(payload, req => retryPublishJob(payload, req, String(job!.id), 'synthetic failure', new Date(Date.now() - 1)))
    expect(await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req))).toMatchObject({ id: job!.id, attempts: 2 })
  })
})
