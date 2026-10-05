import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { migrations } from '../src/migrations/index.js'

const directory = mkdtempSync(join(tmpdir(), 'mail-replies-rollback-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function database(name: string) {
  const client = createClient({ url: `file:${join(directory, name)}` })
  const db = drizzle(client)
  const index = migrations.findIndex((migration) => migration.name === '20261005_191000_mail_replies')
  for (const migration of migrations.slice(0, index)) await migration.up({ db } as never)
  return { client, db, migration: migrations[index]! }
}

test('mail reply rollback supports empty and lead-only data without losing authorizations', async () => {
  const empty = await database('empty.sqlite')
  await empty.migration.up({ db: empty.db } as never); await empty.migration.down({ db: empty.db } as never)
  expect((await empty.client.execute("PRAGMA table_info(mail_drafts)")).rows.some((row) => row.name === 'application_id')).toBe(false)
  await empty.client.close()

  const lead = await database('lead.sqlite'); await lead.migration.up({ db: lead.db } as never)
  const inquiry = randomUUID(); const user = randomUUID(); const draft = randomUUID(); const authorization = randomUUID()
  await lead.client.batch([
    { sql: 'INSERT INTO users (id, email, name, updated_at, created_at) VALUES (?, ?, ?, ?, ?)', args: [user, 'owner@example.test', 'Owner', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z'] },
    { sql: 'INSERT INTO inquiries (id, email, message, topic, source_page, consented_at, consent_basis, idempotency_key, stage, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [inquiry, 'lead@example.test', 'hello', 'general', '/', '2026-10-05T00:00:00.000Z', 'visitor-confirmed', randomUUID(), 'new', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z'] },
    { sql: 'INSERT INTO mail_drafts (id, lead_id, thread_i_d, recipient, sender, subject, body, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [draft, inquiry, 'thread', 'lead@example.test', 'staff@example.test', 'Subject', 'Body', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z'] },
    { sql: 'INSERT INTO mail_authorizations (id, draft_id, digest, draft_revision, authorized_by_id, expires_at, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', args: [authorization, draft, 'digest', 1, user, '2026-10-06T00:00:00.000Z', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z'] },
  ])
  await lead.migration.down({ db: lead.db } as never)
  expect((await lead.client.execute({ sql: 'SELECT id FROM mail_drafts WHERE id = ?', args: [draft] })).rows).toHaveLength(1)
  expect((await lead.client.execute({ sql: 'SELECT id FROM mail_authorizations WHERE id = ?', args: [authorization] })).rows).toHaveLength(1)
  await lead.client.close()
}, 60_000)

test('mail reply rollback refuses career data without changing either record', async () => {
  const fixture = await database('career.sqlite'); await fixture.migration.up({ db: fixture.db } as never)
  const application = randomUUID(); const draft = randomUUID()
  await fixture.client.batch([
    { sql: 'INSERT INTO applications (id, name, email, cover_letter, consent, job_id, resume_key, idempotency_key, status, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [application, 'Applicant', 'applicant@example.test', 'hello', 1, randomUUID(), 'resume', randomUUID(), 'new', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z'] },
    { sql: 'INSERT INTO mail_drafts (id, application_id, thread_i_d, recipient, sender, subject, body, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [draft, application, 'thread', 'applicant@example.test', 'staff@example.test', 'Subject', 'Body', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z'] },
  ])
  await expect(fixture.migration.down({ db: fixture.db } as never)).rejects.toThrow('career reply data exists')
  expect((await fixture.client.execute({ sql: 'SELECT application_id FROM mail_drafts WHERE id = ?', args: [draft] })).rows[0]?.application_id).toBe(application)
  await fixture.client.close()
}, 60_000)
