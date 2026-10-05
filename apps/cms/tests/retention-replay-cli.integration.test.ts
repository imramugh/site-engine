import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { applicationStorage, storeResume } from '../src/applications'
import { purgeApplication } from '../src/retention'

const directory = mkdtempSync(join(tmpdir(), 'retention-replay-cli-'))
const authoritative = join(directory, 'authoritative')
const restored = join(directory, 'restored')
const authoritativeDatabase = join(authoritative, 'cms.sqlite')
const authoritativeApplications = join(authoritative, 'applications')
const authoritativeMedia = join(authoritative, 'media')
const ledger = join(directory, 'deletions.ndjson')
const cmsDirectory = process.cwd().endsWith('/apps/cms') ? process.cwd() : join(process.cwd(), 'apps/cms')
const tsx = join(cmsDirectory, 'node_modules/tsx/dist/cli.mjs')
mkdirSync(authoritative, { recursive: true })
process.env.DATABASE_URI = `file:${authoritativeDatabase}`
process.env.APPLICATION_STORAGE_DIR = authoritativeApplications
process.env.MEDIA_STORAGE_DIR = authoritativeMedia
process.env.PAYLOAD_SECRET = 'retention-replay-cli-test-secret-long-enough'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'https://cms.retention-replay.test'
process.env.RETENTION_TOMBSTONES_FILE = ledger
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => {
  writeFileSync(ledger, '')
  chmodSync(ledger, 0o600)
  payload = await getPayload({ config })
})
afterAll(async () => {
  await payload?.destroy()
  rmSync(directory, { recursive: true, force: true })
  delete process.env.RETENTION_TOMBSTONES_FILE
})

function child(environment: Record<string, string>, script: string, arguments_: string[] = []) {
  const result = spawnSync(process.execPath, [tsx, script, ...arguments_], { cwd: cmsDirectory, env: { ...process.env, ...environment }, encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}

describe('ENG-037 offline deletion-ledger replay', () => {
  it('replays the newest independent ledger against an older SQLite/object checkpoint before restored data can be read', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `replay-owner-${crypto.randomUUID()}@example.test`, name: 'Replay owner', roles: ['owner'] }, overrideAccess: true })
    const resumeKey = storeResume({ data: Buffer.from('private synthetic resume'), name: 'resume.pdf' })
    const application = await payload.create({ collection: 'applications', data: { name: 'Restore fixture', email: `${crypto.randomUUID()}@example.test`, coverLetter: 'Private application content to prove replay deletion.', consent: true, jobId: crypto.randomUUID(), resumeKey, idempotencyKey: crypto.randomUUID() }, overrideAccess: true })
    const draft = await payload.create({ collection: 'mail-drafts', data: { application: application.id, threadID: crypto.randomUUID(), recipient: application.email, sender: 'owner@example.test', subject: 'Private reply', body: 'Private draft body.', attachmentHashes: [], revision: 1, state: 'prepared' }, overrideAccess: true })
    const authorization = await payload.create({ collection: 'mail-authorizations', data: { draft: draft.id, digest: 'a'.repeat(64), draftRevision: 1, authorizedBy: owner.id, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
    const outbox = await payload.create({ collection: 'notification-outbox', data: { kind: 'new-job-application', idempotencyKey: `replay-${crypto.randomUUID()}`, state: 'queued', payload: { application: application.id }, recipientRules: [], recipients: [], channels: [], sourceType: 'application', sourceID: application.id, availableAt: new Date().toISOString() }, overrideAccess: true })
    const note = await payload.create({ collection: 'audit-events', data: { event: 'application.note_added', user: owner.id, actor: owner.id, detail: { applicationID: application.id, body: 'Private interview note.' } }, overrideAccess: true })

    await (payload.db as unknown as { client: { execute: (sql: string) => Promise<unknown> } }).client.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    const restoreDatabase = join(restored, 'cms.sqlite')
    const restoreApplications = join(restored, 'applications')
    mkdirSync(restored, { recursive: true })
    copyFileSync(authoritativeDatabase, restoreDatabase)
    cpSync(authoritativeApplications, restoreApplications, { recursive: true })
    const restoredResume = join(restoreApplications, resumeKey)
    expect(existsSync(restoredResume)).toBe(true)

    await expect(purgeApplication(payload, application.id, owner.id)).resolves.toMatchObject({ state: 'completed' })
    const replayLedger = join(restored, 'newest-deletions.ndjson')
    copyFileSync(ledger, replayLedger)
    chmodSync(replayLedger, 0o600)
    await payload.destroy()

    const environment = { NODE_ENV: 'production', DATABASE_URI: `file:${restoreDatabase}`, APPLICATION_STORAGE_DIR: restoreApplications, MEDIA_STORAGE_DIR: join(restored, 'media'), RETENTION_TOMBSTONES_FILE: replayLedger, PAYLOAD_SECRET: process.env.PAYLOAD_SECRET! }
    const replay = child(environment, 'scripts/replay-deletion-tombstones.ts')
    expect(replay.status, `${replay.stdout}\n${replay.stderr}`).toBe(0)
    expect(replay.stdout).toContain('Replayed 1 deletion ledger entries; reapplied 1 purges.')
    expect(existsSync(restoredResume)).toBe(false)

    const verifier = join(cmsDirectory, `.retention-verify-${crypto.randomUUID()}.mts`)
    writeFileSync(verifier, `import { getPayload } from 'payload'\nimport config from ${JSON.stringify(join(cmsDirectory, 'payload.config.ts'))}\nconst payload = await getPayload({ config })\ntry {\n  const id = process.env.RESTORE_APPLICATION_ID!\n  const app = await payload.findByID({ collection: 'applications', id, overrideAccess: true }).then(() => true).catch(() => false)\n  const drafts = await payload.find({ collection: 'mail-drafts', where: { application: { equals: id } }, limit: 0, pagination: false, overrideAccess: true })\n  const grants = await payload.find({ collection: 'mail-authorizations', where: { draft: { equals: ${JSON.stringify(draft.id)} } }, limit: 0, pagination: false, overrideAccess: true })\n  const outbox = await payload.find({ collection: 'notification-outbox', where: { sourceID: { equals: id } }, limit: 0, pagination: false, overrideAccess: true })\n  const note = await payload.findByID({ collection: 'audit-events', id: ${JSON.stringify(note.id)}, overrideAccess: true })\n  console.log('VERIFY:' + JSON.stringify({ app, drafts: drafts.totalDocs, grants: grants.totalDocs, outbox: outbox.totalDocs, note: note.detail }))\n} finally { await payload.destroy() }\n`)
    let verified: ReturnType<typeof child>
    try { verified = child({ ...environment, RESTORE_APPLICATION_ID: application.id }, verifier) } finally { unlinkSync(verifier) }
    expect(verified.status, `${verified.stdout}\n${verified.stderr}`).toBe(0)
    const marker = verified.stdout.split('\n').find((line) => line.startsWith('VERIFY:'))
    expect(JSON.parse(marker!.slice('VERIFY:'.length))).toEqual({ app: false, drafts: 0, grants: 0, outbox: 0, note: { applicationID: application.id, retentionRedacted: true } })
    expect(authorization.id).toBeTruthy()
  }, 30_000)

  it('fails closed before Payload boot when the copied ledger is malformed or incomplete', () => {
    for (const [name, content] of [['malformed', '{not json}\n'], ['incomplete', JSON.stringify({ resourceType: 'application', resourceID: crypto.randomUUID(), deletedAt: new Date().toISOString() })]]) {
      const broken = join(directory, `${name}.ndjson`)
      writeFileSync(broken, content)
      chmodSync(broken, 0o600)
      const result = child({ NODE_ENV: 'production', DATABASE_URI: 'file:/not-a-real-restored-database.sqlite', RETENTION_TOMBSTONES_FILE: broken, PAYLOAD_SECRET: process.env.PAYLOAD_SECRET! }, 'scripts/replay-deletion-tombstones.ts')
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/Deletion ledger (contains an invalid entry|ends with an incomplete entry)/)
      expect(result.stdout).not.toContain('Replayed ')
    }
  }, 30_000)
})
