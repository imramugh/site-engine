import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { afterAll, describe, expect, it } from 'vitest'
import { migrations } from '../src/migrations/index.js'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-provider-settings-migration-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('ENG-027 provider settings migration', () => {
  it('adds settings to a production-shaped legacy database without changing its encrypted credential and rolls back safely', async () => {
    const client = createClient({ url: `file:${join(directory, 'upgrade.sqlite')}` }); const db = drizzle(client)
    const targetIndex = migrations.findIndex(migration => migration.name === '20261011_010000_provider_settings'); const target = migrations[targetIndex]!
    for (const [batch, migration] of migrations.slice(0, targetIndex).entries()) { await migration.up({ db } as never); await client.execute({ sql: 'INSERT INTO payload_migrations (id, name, batch) VALUES (?, ?, ?)', args: [randomUUID(), migration.name, batch] }) }
    const id = '11111111-1111-4111-8111-111111111111'; const credential = 'v1.production-envelope'
    await client.execute({ sql: 'INSERT INTO integration_configurations (id, provider, model, encrypted_credential, credential_fingerprint, health) VALUES (?, ?, ?, ?, ?, ?)', args: [id, 'openai', 'legacy-model', credential, 'fingerprint', 'connected'] })
    await target.up({ db } as never)
    expect((await client.execute({ sql: 'SELECT encrypted_credential, provider_settings FROM integration_configurations WHERE id = ?', args: [id] })).rows[0]).toMatchObject({ encrypted_credential: credential, provider_settings: '{}' })
    await client.execute({ sql: 'UPDATE integration_configurations SET provider_settings = ? WHERE id = ?', args: ['{\"imageInput\":false}', id] })
    expect((await client.execute({ sql: 'SELECT provider_settings FROM integration_configurations WHERE id = ?', args: [id] })).rows[0]).toMatchObject({ provider_settings: '{\"imageInput\":false}' })
    await target.down({ db } as never)
    const columns = await client.execute("SELECT name FROM pragma_table_info('integration_configurations') WHERE name = 'provider_settings'")
    expect(columns.rows).toHaveLength(0)
    expect((await client.execute({ sql: 'SELECT encrypted_credential FROM integration_configurations WHERE id = ?', args: [id] })).rows[0]).toMatchObject({ encrypted_credential: credential })
    await client.close()
  }, 60_000)
})
