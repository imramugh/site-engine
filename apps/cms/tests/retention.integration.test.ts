import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { applicationStorage, storeResume } from '../src/applications'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'
import { purgeApplication, purgeRetainedInquiry, reapplyDeletionTombstones, retentionEligible, runRetentionCleanup, writeDeletionTombstone } from '../src/retention'

const directory = mkdtempSync(join(tmpdir(), 'retention-sqlite-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.APPLICATION_STORAGE_DIR = join(directory, 'applications')
process.env.MEDIA_STORAGE_DIR = join(directory, 'media')
process.env.PAYLOAD_SECRET = 'retention-test-secret-long-enough'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'https://cms.retention.test'
const ledger = join(directory, 'deletions.ndjson')
const { default: config } = await import('../payload.config.js')
const { DELETE: retentionDELETE } = await import('../app/api/retention/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }); delete process.env.RETENTION_TOMBSTONES_FILE })

async function user(role: 'owner' | 'editor', fresh = true) {
  const account = await payload.create({ collection: 'users', data: { email: `${role}-${crypto.randomUUID()}@example.test`, name: role, roles: [role] }, overrideAccess: true })
  const token = newOpaqueToken(); const now = Date.now()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: account.id, authenticatedAt: new Date(now - (fresh ? 0 : 16 * 60_000)).toISOString(), lastSeenAt: new Date(now).toISOString(), expiresAt: new Date(now + 60 * 60_000).toISOString() }, overrideAccess: true })
  return { account, cookie: `${cookieName(SESSION_COOKIE)}=${token}` }
}
async function application() {
  const key = storeResume({ data: Buffer.from('resume'), name: 'resume.pdf' })
  return payload.create({ collection: 'applications', data: { name: 'Applicant', email: `${crypto.randomUUID()}@example.test`, coverLetter: 'Synthetic application used only for retention verification.', consent: true, jobId: crypto.randomUUID(), resumeKey: key, idempotencyKey: crypto.randomUUID() }, overrideAccess: true })
}

describe('ENG-037 real SQLite retention privacy lifecycle', () => {
  it('fails closed before object deletion when the durable ledger is unavailable, then retries to completion', async () => {
    const owner = await user('owner'); const record = await application(); const object = join(applicationStorage(), record.resumeKey)
    delete process.env.RETENTION_TOMBSTONES_FILE
    await expect(purgeApplication(payload, record.id, owner.account.id)).resolves.toMatchObject({ state: 'failed' })
    expect(existsSync(object)).toBe(true)
    await expect(payload.findByID({ collection: 'applications', id: record.id, overrideAccess: true })).resolves.toMatchObject({ id: record.id })
    const failed = await payload.find({ collection: 'retention-purge-jobs', where: { resourceID: { equals: record.id } }, overrideAccess: true })
    expect(failed.docs[0]).toMatchObject({ state: 'failed', attempts: 1 })
    writeFileSync(ledger, ''); chmodSync(ledger, 0o600); process.env.RETENTION_TOMBSTONES_FILE = ledger
    await expect(purgeApplication(payload, record.id, owner.account.id)).resolves.toMatchObject({ state: 'completed' })
    expect(existsSync(object)).toBe(false)
    await expect(payload.findByID({ collection: 'applications', id: record.id, overrideAccess: true })).rejects.toMatchObject({ status: 404 })
    expect((await payload.find({ collection: 'retention-purge-jobs', where: { resourceID: { equals: record.id } }, overrideAccess: true })).docs[0]).toMatchObject({ state: 'completed', resumeKey: null })
    const entry = JSON.parse(String((await import('node:fs')).readFileSync(ledger, 'utf8').trim()))
    expect(entry).toEqual({ resourceType: 'application', resourceID: record.id, deletedAt: expect.any(String) })
    expect(JSON.stringify(entry)).not.toMatch(/Applicant|resume|example\.test/)
  })

  it('purges an application resume and all application-bound correspondence atomically', async () => {
    writeFileSync(ledger, ''); chmodSync(ledger, 0o600); process.env.RETENTION_TOMBSTONES_FILE = ledger
    const owner = await user('owner'); const record = await application(); const resume = join(applicationStorage(), record.resumeKey)
    const draft = await payload.create({ collection: 'mail-drafts', data: { application: record.id, threadID: crypto.randomUUID(), recipient: record.email, sender: 'owner@example.test', subject: 'Reply', body: 'Synthetic private correspondence.', attachmentHashes: [], revision: 1, state: 'prepared' }, overrideAccess: true })
    const authorization = await payload.create({ collection: 'mail-authorizations', data: { draft: draft.id, digest: 'a'.repeat(64), draftRevision: 1, authorizedBy: owner.account.id, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
    const outbox = await payload.create({ collection: 'notification-outbox', data: { kind: 'new-job-application', idempotencyKey: `retention-${crypto.randomUUID()}`, state: 'queued', payload: { application: record.id }, recipientRules: [], recipients: [], channels: [], sourceType: 'application', sourceID: record.id, availableAt: new Date().toISOString() }, overrideAccess: true })
    const note = await payload.create({ collection: 'audit-events', data: { event: 'application.note_added', user: owner.account.id, actor: owner.account.id, detail: { applicationID: record.id, body: 'Synthetic hiring note that must not survive retention deletion.' } }, overrideAccess: true })
    await expect(purgeApplication(payload, record.id, owner.account.id)).resolves.toMatchObject({ state: 'completed' })
    expect(existsSync(resume)).toBe(false)
    await expect(payload.findByID({ collection: 'applications', id: record.id, overrideAccess: true })).rejects.toMatchObject({ status: 404 })
    await expect(payload.findByID({ collection: 'mail-drafts', id: draft.id, overrideAccess: true })).rejects.toMatchObject({ status: 404 })
    await expect(payload.findByID({ collection: 'mail-authorizations', id: authorization.id, overrideAccess: true })).rejects.toMatchObject({ status: 404 })
    await expect(payload.findByID({ collection: 'notification-outbox', id: outbox.id, overrideAccess: true })).rejects.toMatchObject({ status: 404 })
    await expect(payload.findByID({ collection: 'audit-events', id: note.id, overrideAccess: true })).resolves.toMatchObject({ event: 'application.note_added', detail: { applicationID: record.id, retentionRedacted: true } })
  })

  it('requires a fresh Owner for permanent deletion and denies an Editor without changing the record', async () => {
    const record = await application(); const editor = await user('editor'); const staleOwner = await user('owner', false)
    const invoke = (cookie: string) => retentionDELETE(new Request('https://cms.retention.test/api/retention', { method: 'DELETE', headers: { origin: 'https://cms.retention.test', cookie, 'content-type': 'application/json' }, body: JSON.stringify({ applicationID: record.id }) }))
    expect((await invoke(editor.cookie)).status).toBe(403)
    expect((await invoke(staleOwner.cookie)).status).toBe(403)
    await expect(payload.findByID({ collection: 'applications', id: record.id, overrideAccess: true })).resolves.toMatchObject({ id: record.id })
  })

  it('does not report success or delete the row when the private resume purge fails', async () => {
    writeFileSync(ledger, ''); chmodSync(ledger, 0o600); process.env.RETENTION_TOMBSTONES_FILE = ledger
    const record = await payload.create({ collection: 'applications', data: { name: 'Retry', email: `${crypto.randomUUID()}@example.test`, coverLetter: 'Synthetic record with a deliberately invalid private object key.', consent: true, jobId: crypto.randomUUID(), resumeKey: 'not-a-resume-key', idempotencyKey: crypto.randomUUID() }, overrideAccess: true })
    await expect(purgeApplication(payload, record.id, undefined)).resolves.toMatchObject({ state: 'failed' })
    await expect(payload.findByID({ collection: 'applications', id: record.id, overrideAccess: true })).resolves.toMatchObject({ id: record.id })
    expect((await payload.find({ collection: 'retention-purge-jobs', where: { resourceID: { equals: record.id } }, overrideAccess: true })).docs[0]).toMatchObject({ state: 'failed', lastError: 'storage-purge-failed' })
  })

  it('makes concurrent application purge calls one completed idempotent job', async () => {
    writeFileSync(ledger, ''); chmodSync(ledger, 0o600); process.env.RETENTION_TOMBSTONES_FILE = ledger
    const record = await application()
    const outcomes = await Promise.all([purgeApplication(payload, record.id, undefined), purgeApplication(payload, record.id, undefined)])
    expect(outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'completed' })]))
    const jobs = await payload.find({ collection: 'retention-purge-jobs', where: { and: [{ resourceType: { equals: 'application' } }, { resourceID: { equals: record.id } }] }, overrideAccess: true })
    expect(jobs.docs).toHaveLength(1)
    expect(jobs.docs[0]).toMatchObject({ state: 'completed' })
    await expect(payload.findByID({ collection: 'applications', id: record.id, overrideAccess: true })).rejects.toMatchObject({ status: 404 })
  })

  it('replays a minimal deletion marker before restored data is served', async () => {
    await (payload.db as unknown as { client: { execute: (sql: string) => Promise<unknown> } }).client.execute('DELETE FROM deletion_tombstones')
    const owner = await user('owner'); const record = await application();
    // This copied database represents an older restore point containing the application.
    copyFileSync(join(directory, 'cms.sqlite'), join(directory, 'older-before-purge.sqlite'))
    await writeDeletionTombstone(payload, undefined, 'application', record.id)
    process.env.RETENTION_TOMBSTONES_FILE = ledger
    await expect(reapplyDeletionTombstones(payload)).resolves.toBeGreaterThanOrEqual(1)
    await expect(payload.findByID({ collection: 'applications', id: record.id, overrideAccess: true })).rejects.toMatchObject({ status: 404 })
    expect(owner.account.id).toBeTruthy()
  })

  it('keeps active inquiries and applies the exact 30-day spam boundary', async () => {
    const old = new Date('2026-09-05T12:00:00.000Z'); const now = new Date('2026-10-05T12:00:00.000Z')
    expect(retentionEligible(old.toISOString(), now)).toBe(true)
    const active = await payload.create({ collection: 'inquiries', data: { email: `${crypto.randomUUID()}@example.test`, message: 'Active inquiry retained despite the cleanup clock.', topic: 'general', sourcePage: '/', consentedAt: old.toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: crypto.randomUUID(), spam: false, stage: 'new' }, draft: false, overrideAccess: true })
    await runRetentionCleanup(payload, now)
    await expect(payload.findByID({ collection: 'inquiries', id: active.id, overrideAccess: true })).resolves.toMatchObject({ id: active.id, spam: false })
  })

  it('purges spam exactly at the policy boundary while preserving newer spam and active inquiries', async () => {
    writeFileSync(ledger, ''); chmodSync(ledger, 0o600); process.env.RETENTION_TOMBSTONES_FILE = ledger
    const now = new Date('2026-10-05T12:00:00.000Z')
    const create = (key: string, spam: boolean, markedAt: string) => payload.create({ collection: 'inquiries', data: { email: `${key}@example.test`, message: key, topic: 'general', sourcePage: '/', consentedAt: markedAt, consentBasis: 'visitor-confirmed', idempotencyKey: crypto.randomUUID(), stage: 'new', spam, ...(spam ? { spamMarkedAt: markedAt, spamPreviousStage: 'new' } : {}) }, draft: false, overrideAccess: true })
    const boundary = await create('boundary', true, '2026-09-05T12:00:00.000Z')
    const newer = await create('newer', true, '2026-09-05T12:00:00.001Z')
    const active = await create('active', false, '2026-08-01T00:00:00.000Z')
    await expect(runRetentionCleanup(payload, now)).resolves.toMatchObject({ spam: expect.any(Number) })
    await expect(payload.findByID({ collection: 'inquiries', id: boundary.id, overrideAccess: true })).rejects.toMatchObject({ status: 404 })
    await expect(payload.findByID({ collection: 'inquiries', id: newer.id, overrideAccess: true })).resolves.toMatchObject({ id: newer.id, spam: true })
    await expect(payload.findByID({ collection: 'inquiries', id: active.id, overrideAccess: true })).resolves.toMatchObject({ id: active.id, spam: false })
    expect((await payload.find({ collection: 'retention-purge-jobs', where: { resourceID: { equals: boundary.id } }, overrideAccess: true })).docs[0]).toMatchObject({ resourceType: 'spam-inquiry', state: 'completed' })
  })

  it('permanently purges a retained non-spam inquiry only through the retention lifecycle', async () => {
    writeFileSync(ledger, ''); chmodSync(ledger, 0o600); process.env.RETENTION_TOMBSTONES_FILE = ledger
    const inquiry = await payload.create({ collection: 'inquiries', data: { email: `${crypto.randomUUID()}@example.test`, message: 'Manual deletion proof.', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: crypto.randomUUID(), spam: false, stage: 'new' }, draft: false, overrideAccess: true })
    await expect(purgeRetainedInquiry(payload, inquiry.id, undefined)).resolves.toBeUndefined()
    await expect(payload.findByID({ collection: 'inquiries', id: inquiry.id, overrideAccess: true })).rejects.toMatchObject({ status: 404 })
    expect((await payload.find({ collection: 'deletion-tombstones', where: { resourceID: { equals: inquiry.id } }, overrideAccess: true })).docs[0]).toMatchObject({ resourceType: 'inquiry' })
  })
})
