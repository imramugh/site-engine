import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { afterAll, describe, expect, it } from 'vitest'
import { migrations } from '../src/migrations/index.js'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-media-version-migration-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('immutable media version migration', () => {
  it('preserves legacy assets through upgrade and rollback', async () => {
    const client = createClient({ url: `file:${join(directory, 'upgrade.sqlite')}` })
    const db = drizzle(client)
    const targetIndex = migrations.findIndex((migration) => migration.name === '20261004_235511_media_immutable_versions')
    expect(targetIndex).toBeGreaterThan(0)
    const target = migrations[targetIndex]!
    for (const migration of migrations.slice(0, targetIndex)) await migration.up({ db } as never)
    const assetID = randomUUID()
    await client.execute({ sql: 'INSERT INTO assets (id, alt, decorative, filename, mime_type, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [assetID, 'Legacy image', 0, 'legacy.png', 'image/png', 10, 10] })
    await target.up({ db } as never)
    expect((await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='asset_file_versions'")).rows).toHaveLength(1)
    expect((await client.execute("SELECT name FROM pragma_table_info('assets') WHERE name IN ('current_file_version_id', 'current_file')")).rows).toHaveLength(2)
    expect((await client.execute({ sql: 'SELECT filename FROM assets WHERE id = ?', args: [assetID] })).rows[0]?.filename).toBe('legacy.png')
    const versionID = randomUUID()
    await client.execute({ sql: 'INSERT INTO asset_file_versions (id, parent_asset_id, digest, version_key, idempotency_key, original_filename, filename) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [versionID, assetID, 'a'.repeat(64), `${assetID}:${'a'.repeat(64)}`, randomUUID(), 'replacement.png', `${assetID}-${'a'.repeat(64)}.png`] })
    await client.execute({ sql: 'UPDATE assets SET current_file_version_id = ?, current_file = ? WHERE id = ?', args: [versionID, JSON.stringify({ filename: `${assetID}-${'a'.repeat(64)}.png`, originalFilename: 'replacement.png' }), assetID] })
    expect((await client.execute({ sql: 'SELECT original_filename FROM asset_file_versions WHERE id = ?', args: [versionID] })).rows[0]?.original_filename).toBe('replacement.png')
    await target.down({ db } as never)
    expect((await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='asset_file_versions'")).rows).toHaveLength(0)
    expect((await client.execute("SELECT name FROM pragma_table_info('assets') WHERE name IN ('current_file_version_id', 'current_file')")).rows).toHaveLength(0)
    expect((await client.execute({ sql: 'SELECT filename FROM assets WHERE id = ?', args: [assetID] })).rows[0]?.filename).toBe('legacy.png')
    await client.close()
  }, 120_000)
})
