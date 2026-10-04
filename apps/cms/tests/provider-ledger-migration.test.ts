import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { afterAll, describe, expect, it } from 'vitest'
import { migrations } from '../src/migrations/index.js'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-provider-ledger-migration-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function database(name: string) {
  const client = createClient({ url: `file:${join(directory, name)}` })
  return { client, db: drizzle(client) }
}

describe('provider ledger migration', () => {
  it('upgrades all 29 deployed migrations and preserves an encrypted configuration through down', async () => {
    const { client, db } = database('upgrade.sqlite')
    const ledger = migrations.find(migration => migration.name === '20261004_010000_provider_ledger')
    const deployed = migrations.filter(migration => migration.name !== '20261004_010000_provider_ledger')
    expect(ledger).toBeDefined()
    expect(deployed).toHaveLength(29)
    for (const [batch, migration] of deployed.entries()) {
      await migration.up({ db } as never)
      // The migration runner records each deployed migration separately; retain
      // those records to exercise an upgrade database rather than a fresh schema.
      await client.execute({ sql: 'INSERT INTO payload_migrations (id, name, batch) VALUES (?, ?, ?)', args: [randomUUID(), migration.name, batch] })
    }
    const id = '11111111-1111-4111-8111-111111111111'
    await client.execute({ sql: 'INSERT INTO integration_configurations (id, provider, model, monthly_cap, encrypted_credential, credential_fingerprint, health) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [id, 'openai', 'preserved-model', 12345, 'ciphertext', 'preserved-fingerprint', 'connected'] })
    expect((await client.execute('SELECT count(*) AS count FROM payload_migrations')).rows[0].count).toBe(29)
    await ledger!.up({ db } as never)
    const upgraded = (await client.execute({ sql: 'SELECT model, monthly_cap, encrypted_credential, credential_fingerprint, monthly_cap_micro_usd, monthly_usage_micro_usd FROM integration_configurations WHERE id = ?', args: [id] })).rows[0]
    expect(upgraded).toMatchObject({ model: 'preserved-model', monthly_cap: 12345, encrypted_credential: 'ciphertext', credential_fingerprint: 'preserved-fingerprint', monthly_cap_micro_usd: null, monthly_usage_micro_usd: 0 })
    await ledger!.down({ db } as never)
    const rolledBack = (await client.execute({ sql: 'SELECT model, monthly_cap, encrypted_credential, credential_fingerprint FROM integration_configurations WHERE id = ?', args: [id] })).rows[0]
    expect(rolledBack).toMatchObject({ model: 'preserved-model', monthly_cap: 12345, encrypted_credential: 'ciphertext', credential_fingerprint: 'preserved-fingerprint' })
    expect((await client.execute('SELECT count(*) AS count FROM payload_migrations')).rows[0].count).toBe(29)
    await client.close()
  }, 60_000)
})
