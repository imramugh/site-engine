import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, expect, test } from 'vitest'
import { migrations } from '../src/migrations/index.js'

const directory = mkdtempSync(join(tmpdir(), 'crawler-policy-migration-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test('crawler policy migration preserves existing site settings and rolls down cleanly', async () => {
  const client = createClient({ url: `file:${join(directory, 'upgrade.sqlite')}` })
  const db = drizzle(client)
  const index = migrations.findIndex(migration => migration.name === '20261005_164500_crawler_policy_1_7')
  expect(index).toBeGreaterThan(0)
  for (const migration of migrations.slice(0, index)) await migration.up({ db } as never)
  const id = randomUUID()
  await client.execute({ sql: 'INSERT INTO site_settings (id, key, site_name, default_locale) VALUES (?, ?, ?, ?)', args: [id, 'active', 'Preserved site', 'en-CA'] })
  const migration = migrations[index]!
  await migration.up({ db } as never)
  expect((await client.execute({ sql: 'SELECT site_name, crawler_policy FROM site_settings WHERE id = ?', args: [id] })).rows[0]).toMatchObject({ site_name: 'Preserved site', crawler_policy: null })
  const policy = JSON.stringify({ searchEngines: true, aiSearchAndAnswers: false, aiModelTraining: false })
  await client.execute({ sql: 'UPDATE site_settings SET crawler_policy = ? WHERE id = ?', args: [policy, id] })
  expect((await client.execute({ sql: 'SELECT crawler_policy FROM site_settings WHERE id = ?', args: [id] })).rows[0]?.crawler_policy).toBe(policy)
  await migration.down({ db } as never)
  expect((await client.execute({ sql: 'SELECT site_name FROM site_settings WHERE id = ?', args: [id] })).rows[0]?.site_name).toBe('Preserved site')
  expect((await client.execute("SELECT count(*) AS count FROM pragma_table_info('site_settings') WHERE name = 'crawler_policy'")).rows[0]?.count).toBe(0)
  await client.close()
}, 60_000)
