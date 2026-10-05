import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { migrations } from '../src/migrations/index.js'

const directory = mkdtempSync(join(tmpdir(), 'redirect-creator-migration-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test('redirect creator migration preserves legacy rows, creator labels, and rollback constraints', async () => {
  const client = createClient({ url: `file:${join(directory, 'upgrade.sqlite')}` })
  const db = drizzle(client)
  const index = migrations.findIndex(migration => migration.name === '20261005_170000_redirect_creator_attribution')
  expect(index).toBeGreaterThan(0)
  for (const migration of migrations.slice(0, index)) await migration.up({ db } as never)

  const redirectID = randomUUID()
  await client.execute({ sql: 'INSERT INTO redirects (id, `from`, `to`, status, hit_count) VALUES (?, ?, ?, ?, ?)', args: [redirectID, '/legacy-path', '/current-path', 301, 17] })
  const migration = migrations[index]!
  await migration.up({ db } as never)
  expect((await client.execute({ sql: 'SELECT `from`, `to`, hit_count, created_by_id, created_by_label FROM redirects WHERE id = ?', args: [redirectID] })).rows[0]).toMatchObject({
    from: '/legacy-path', to: '/current-path', hit_count: 17, created_by_id: null, created_by_label: null,
  })

  const userID = randomUUID()
  await client.execute({ sql: 'INSERT INTO users (id, email, name) VALUES (?, ?, ?)', args: [userID, 'redirect-migration@example.test', 'Preserved creator'] })
  await client.execute({ sql: 'UPDATE redirects SET created_by_id = ?, created_by_label = ? WHERE id = ?', args: [userID, 'Preserved creator', redirectID] })
  await client.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [userID] })
  expect((await client.execute({ sql: 'SELECT created_by_id, created_by_label FROM redirects WHERE id = ?', args: [redirectID] })).rows[0]).toMatchObject({ created_by_id: null, created_by_label: 'Preserved creator' })
  await expect(client.execute({ sql: 'INSERT INTO redirects (id, `from`, `to`, status) VALUES (?, ?, ?, ?)', args: [randomUUID(), '/legacy-path', '/other-path', 301] })).rejects.toThrow()

  await migration.down({ db } as never)
  expect((await client.execute({ sql: 'SELECT `from`, `to`, hit_count FROM redirects WHERE id = ?', args: [redirectID] })).rows[0]).toMatchObject({ from: '/legacy-path', to: '/current-path', hit_count: 17 })
  expect((await client.execute("SELECT count(*) AS count FROM pragma_table_info('redirects') WHERE name IN ('created_by_id', 'created_by_label')")).rows[0]?.count).toBe(0)
  await expect(client.execute({ sql: 'INSERT INTO redirects (id, `from`, `to`, status) VALUES (?, ?, ?, ?)', args: [randomUUID(), '/legacy-path', '/other-path', 301] })).rejects.toThrow()
  await client.close()
}, 60_000)
