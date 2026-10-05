import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { migrations } from '../src/migrations/index.js'

const directory = mkdtempSync(join(tmpdir(), 'application-contact-migration-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test('application contact migration preserves existing applications and rolls back cleanly', async () => {
  const client = createClient({ url: `file:${join(directory, 'upgrade.sqlite')}` })
  const db = drizzle(client)
  const index = migrations.findIndex(migration => migration.name === '20261005_181000_application_contact_fields')
  expect(index).toBeGreaterThan(0)
  for (const migration of migrations.slice(0, index)) await migration.up({ db } as never)

  const applicationID = randomUUID()
  await client.execute({ sql: 'INSERT INTO applications (id, name, email, cover_letter, consent, job_id, resume_key, idempotency_key, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [applicationID, 'Legacy applicant', 'legacy@example.test', 'Legacy letter', 1, randomUUID(), `${randomUUID()}-${'a'.repeat(64)}`, randomUUID(), 'new'] })
  const migration = migrations[index]!
  await migration.up({ db } as never)
  expect((await client.execute({ sql: 'SELECT name, telephone, linked_in FROM applications WHERE id = ?', args: [applicationID] })).rows[0]).toMatchObject({ name: 'Legacy applicant', telephone: null, linked_in: null })
  await client.execute({ sql: 'UPDATE applications SET telephone = ?, linked_in = ? WHERE id = ?', args: ['+1 416 555 0198', 'https://www.linkedin.com/in/legacy', applicationID] })
  expect((await client.execute({ sql: 'SELECT telephone, linked_in FROM applications WHERE id = ?', args: [applicationID] })).rows[0]).toMatchObject({ telephone: '+1 416 555 0198', linked_in: 'https://www.linkedin.com/in/legacy' })

  await migration.down({ db } as never)
  expect((await client.execute({ sql: 'SELECT name, email FROM applications WHERE id = ?', args: [applicationID] })).rows[0]).toMatchObject({ name: 'Legacy applicant', email: 'legacy@example.test' })
  expect((await client.execute("SELECT count(*) AS count FROM pragma_table_info('applications') WHERE name IN ('telephone', 'linked_in')")).rows[0]?.count).toBe(0)
  await client.close()
}, 60_000)
