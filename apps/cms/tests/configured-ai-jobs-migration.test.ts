import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { afterAll, describe, expect, it } from 'vitest'
import { migrations } from '../src/migrations/index.js'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-configured-ai-jobs-migration-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('configured AI jobs migration', () => {
  it('upgrades the 30-migration database, preserves existing ledger configuration, and rolls back only job schema', async () => {
    const client = createClient({ url: `file:${join(directory, 'upgrade.sqlite')}` })
    const db = drizzle(client)
    const targetIndex = migrations.findIndex((migration) => migration.name === '20261004_020000_configured_ai_jobs')
    expect(targetIndex).toBe(30)
    const target = migrations[targetIndex]
    const prior = migrations.slice(0, targetIndex)
    expect(target).toBeDefined(); expect(prior).toHaveLength(30)
    for (const [batch, migration] of prior.entries()) {
      await migration.up({ db } as never)
      await client.execute({ sql: 'INSERT INTO payload_migrations (id, name, batch) VALUES (?, ?, ?)', args: [randomUUID(), migration.name, batch] })
    }
    const configID = '11111111-1111-4111-8111-111111111111'
    await client.execute({ sql: 'INSERT INTO integration_configurations (id, provider, model, encrypted_credential, credential_fingerprint, health, input_micro_usd_per_million_tokens, output_micro_usd_per_million_tokens, pricing_source, pricing_as_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [configID, 'openai', 'preserved-model', 'ciphertext', 'preserved-fingerprint', 'connected', 100, 200, 'https://prices.example.test/pinned', '2026-10-04T00:00:00.000Z'] })
    const before = await client.execute({ sql: 'SELECT model, encrypted_credential, pricing_source FROM integration_configurations WHERE id = ?', args: [configID] })
    expect((await client.execute('SELECT count(*) AS count FROM payload_migrations')).rows[0].count).toBe(30)
    await target!.up({ db } as never)
    expect((await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'configured_ai_jobs'")).rows).toHaveLength(1)
    expect((await client.execute("SELECT name FROM pragma_table_info('payload_locked_documents_rels') WHERE name = 'configured_ai_jobs_id'")).rows).toHaveLength(1)
    expect(await client.execute({ sql: 'SELECT model, encrypted_credential, pricing_source FROM integration_configurations WHERE id = ?', args: [configID] })).toEqual(before)
    await target!.down({ db } as never)
    expect((await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'configured_ai_jobs'")).rows).toHaveLength(0)
    expect((await client.execute("SELECT name FROM pragma_table_info('payload_locked_documents_rels') WHERE name = 'configured_ai_jobs_id'")).rows).toHaveLength(0)
    expect(await client.execute({ sql: 'SELECT model, encrypted_credential, pricing_source FROM integration_configurations WHERE id = ?', args: [configID] })).toEqual(before)
    expect((await client.execute('SELECT count(*) AS count FROM payload_migrations')).rows[0].count).toBe(30)
    await client.close()
  }, 60_000)
})
