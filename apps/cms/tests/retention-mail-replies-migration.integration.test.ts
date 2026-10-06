import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createLocalReq, getPayload } from 'payload'
import type { MigrateUpArgs } from '@payloadcms/db-sqlite'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { up } from '../src/migrations/20261005_191000_mail_replies'
import { migrations } from '../src/migrations'

const directory = mkdtempSync(join(tmpdir(), 'retention-mail-replies-upgrade-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'retention-mail-replies-upgrade-secret'
const previousNodeEnv = process.env.NODE_ENV
process.env.NODE_ENV = 'production'
const { default: config } = await import('../payload.config')
const targetIndex = migrations.findIndex(migration => migration.name === '20261005_191000_mail_replies')
let payload: Awaited<ReturnType<typeof getPayload>>
type Adapter = { sessions: Record<string, { db: MigrateUpArgs['db'] }>; client: { execute: (sql: string) => Promise<{ rows: unknown[] }> } }
beforeAll(async () => {
  // Build the real migrated schema, not Payload's development schema push:
  // SQLite ALTER-added foreign keys have different DDL from generated tables.
  const client = createClient({ url: process.env.DATABASE_URI! })
  try {
    const db = drizzle(client)
    for (const migration of migrations.slice(0, targetIndex)) await migration.up({ db } as never)
  } finally { client.close() }
  payload = await getPayload({ config })
}, 60_000)
afterAll(async () => { await payload?.destroy(); process.env.NODE_ENV = previousNodeEnv; rmSync(directory, { recursive: true, force: true }) })
async function migrate(operation: typeof up) { const transactionID = await payload.db.beginTransaction(); if (!transactionID) throw new Error('Expected transaction'); const req = await createLocalReq({ req: { transactionID } }, payload); const db = (payload.db as unknown as Adapter).sessions[String(transactionID)].db; try { await operation({ db, payload, req }); await payload.db.commitTransaction(transactionID) } catch (error) { await payload.db.rollbackTransaction(transactionID); throw error } }

it('preserves a locked legacy draft and authorization while adding application replies', async () => {
  const owner = { id: '80000000-0000-4000-8000-000000000001', email: 'owner-migration@example.test' }
  const inquiry = { id: '80000000-0000-4000-8000-000000000002', email: 'lead-migration@example.test' }
  const draft = { id: '80000000-0000-4000-8000-000000000003' }
  const client = (payload.db as unknown as Adapter).client
  // Seed the historical schema without asking the latest Payload collection
  // model to read columns that did not exist at this migration boundary.
  await client.execute(`INSERT INTO users (id,email,name,updated_at,created_at) VALUES ('${owner.id}','${owner.email}','Owner','2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z')`)
  await client.execute(`INSERT INTO inquiries (id,email,message,topic,source_page,consented_at,consent_basis,idempotency_key,stage,updated_at,created_at) VALUES ('${inquiry.id}','${inquiry.email}','Legacy draft lead','general','/','2026-10-05T00:00:00.000Z','staff-recorded','mail-replies-upgrade-lead','new','2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z')`)
  await client.execute(`INSERT INTO mail_drafts (id,lead_id,thread_i_d,recipient,sender,subject,body,attachment_hashes,revision,state,updated_at,created_at) VALUES ('${draft.id}','${inquiry.id}','legacy-thread','${inquiry.email}','${owner.email}','Legacy draft','Retain this draft.','[]',1,'prepared','2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z')`)
  await client.execute(`INSERT INTO payload_locked_documents (id, global_slug, updated_at, created_at) VALUES ('90000000-0000-4000-8000-000000000001', NULL, '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z')`)
  await client.execute(`INSERT INTO payload_locked_documents_rels (parent_id, path, mail_drafts_id) VALUES ('90000000-0000-4000-8000-000000000001', 'mail-drafts', '${draft.id}')`)
  const authorization = '90000000-0000-4000-8000-000000000002'
  await client.execute(`INSERT INTO mail_authorizations (id,draft_id,digest,draft_revision,authorized_by_id,expires_at,updated_at,created_at) VALUES ('${authorization}','${draft.id}','${'a'.repeat(64)}',1,'${owner.id}','2026-10-05T01:00:00.000Z','2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z')`)
  await client.execute(`INSERT INTO payload_locked_documents_rels (parent_id, path, mail_authorizations_id) VALUES ('90000000-0000-4000-8000-000000000001', 'mail-authorizations', '${authorization}')`)
  await migrate(up)
  for (const migration of migrations.slice(targetIndex + 1)) await migrate(migration.up)
  expect(await payload.findByID({ collection: 'mail-drafts', id: draft.id, depth: 0, overrideAccess: true })).toMatchObject({ id: draft.id, lead: inquiry.id, subject: 'Legacy draft' })
  expect(await payload.findByID({ collection: 'mail-authorizations', id: authorization, depth: 0, overrideAccess: true })).toMatchObject({ id: authorization, draft: draft.id })
  expect((await client.execute(`SELECT mail_drafts_id FROM payload_locked_documents_rels WHERE parent_id = '90000000-0000-4000-8000-000000000001' AND path = 'mail-drafts'`)).rows).toEqual([expect.objectContaining({ mail_drafts_id: draft.id })])
  expect((await client.execute(`SELECT mail_authorizations_id FROM payload_locked_documents_rels WHERE parent_id = '90000000-0000-4000-8000-000000000001' AND path = 'mail-authorizations'`)).rows).toEqual([expect.objectContaining({ mail_authorizations_id: authorization })])
  const application = await payload.create({ collection: 'applications', data: { name: 'Applicant', email: 'application-migration@example.test', coverLetter: 'Application reply target.', consent: true, jobId: 'migration-job', resumeKey: 'legacy', idempotencyKey: 'mail-replies-upgrade-application' }, overrideAccess: true })
  const applicationDraft = await payload.create({ collection: 'mail-drafts', data: { application: application.id, threadID: 'application-thread', recipient: application.email, sender: owner.email, subject: 'Application reply', body: 'New relation works.', attachmentHashes: [], revision: 1, state: 'prepared' }, overrideAccess: true, context: { migrationFixture: true } })
  expect(await payload.findByID({ collection: 'mail-drafts', id: applicationDraft.id, depth: 0, overrideAccess: true })).toMatchObject({ application: application.id, lead: null })
  expect((await client.execute('PRAGMA foreign_key_check')).rows).toEqual([])
})
