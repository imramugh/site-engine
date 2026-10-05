import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { migrations } from '../src/migrations/index.js'

const directory = mkdtempSync(join(tmpdir(), 'lead-spam-migration-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test('spam migration backfills legacy inquiries and rolls back without losing the lead', async () => {
  const client = createClient({ url: `file:${join(directory, 'upgrade.sqlite')}` })
  const db = drizzle(client)
  const index = migrations.findIndex((migration) => migration.name === '20261005_180000_inquiry_spam_lifecycle')
  expect(index).toBeGreaterThan(0)
  for (const migration of migrations.slice(0, index)) await migration.up({ db } as never)
  const id = randomUUID()
  await client.execute({ sql: 'INSERT INTO inquiries (id,email,message,topic,source_page,consented_at,consent_basis,idempotency_key,stage) VALUES (?,?,?,?,?,?,?,?,?)', args: [id, 'legacy-spam@example.test', 'Legacy lead', 'general', '/contact', new Date().toISOString(), 'unknown', randomUUID(), 'qualified'] })

  const migration = migrations[index]!
  await migration.up({ db } as never)
  expect((await client.execute({ sql: 'SELECT id,stage,spam,spam_marked_at,spam_previous_stage FROM inquiries WHERE id=?', args: [id] })).rows[0]).toMatchObject({ id, stage: 'qualified', spam: 0, spam_marked_at: null, spam_previous_stage: null })
  await migration.down({ db } as never)
  expect((await client.execute({ sql: 'SELECT id,stage FROM inquiries WHERE id=?', args: [id] })).rows[0]).toMatchObject({ id, stage: 'qualified' })
  expect((await client.execute("SELECT count(*) AS count FROM pragma_table_info('inquiries') WHERE name LIKE 'spam%'")).rows[0]?.count).toBe(0)
  await client.close()
}, 120_000)
