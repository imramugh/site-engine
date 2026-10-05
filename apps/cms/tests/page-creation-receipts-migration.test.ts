import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { afterAll, describe, expect, it } from 'vitest'
import { migrations } from '../src/migrations/index.js'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-page-creation-receipts-migration-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('page creation receipt migration', () => {
  it('preserves existing sets, enforces unique receipts, and survives a down-up cycle', async () => {
    const client = createClient({ url: `file:${join(directory, 'upgrade.sqlite')}` })
    const db = drizzle(client)
    const targetIndex = migrations.findIndex((migration) => migration.name === '20261004_031000_page_creation_receipts')
    expect(targetIndex).toBeGreaterThan(0)
    const target = migrations[targetIndex]!
    for (const migration of migrations.slice(0, targetIndex)) await migration.up({ db } as never)

    const existingID = randomUUID()
    await client.execute({ sql: 'INSERT INTO change_sets (id, name) VALUES (?, ?)', args: [existingID, 'Existing editorial set'] })
    await target.up({ db } as never)
    expect((await client.execute({ sql: 'SELECT name, creation_request_key, creation_request_hash FROM change_sets WHERE id = ?', args: [existingID] })).rows[0]).toMatchObject({ name: 'Existing editorial set', creation_request_key: null, creation_request_hash: null })

    const receiptKey = randomUUID()
    await client.execute({ sql: 'UPDATE change_sets SET creation_request_key = ?, creation_request_hash = ? WHERE id = ?', args: [receiptKey, 'a'.repeat(64), existingID] })
    const duplicateID = randomUUID()
    await client.execute({ sql: 'INSERT INTO change_sets (id, name) VALUES (?, ?)', args: [duplicateID, 'Second editorial set'] })
    await expect(client.execute({ sql: 'UPDATE change_sets SET creation_request_key = ?, creation_request_hash = ? WHERE id = ?', args: [receiptKey, 'b'.repeat(64), duplicateID] })).rejects.toThrow()

    await target.down({ db } as never)
    expect((await client.execute("SELECT name FROM pragma_table_info('change_sets') WHERE name LIKE 'creation_request_%'")).rows).toHaveLength(0)
    expect((await client.execute({ sql: 'SELECT id FROM change_sets WHERE id IN (?, ?)', args: [existingID, duplicateID] })).rows).toHaveLength(2)

    await target.up({ db } as never)
    expect((await client.execute("SELECT name FROM pragma_table_info('change_sets') WHERE name LIKE 'creation_request_%'")).rows).toHaveLength(2)
    expect((await client.execute({ sql: 'SELECT id FROM change_sets WHERE id IN (?, ?)', args: [existingID, duplicateID] })).rows).toHaveLength(2)
    await client.close()
  }, 60_000)
})
