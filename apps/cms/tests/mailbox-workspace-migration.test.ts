import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, expect, test } from 'vitest'
import { migrations } from '../src/migrations/index.js'

const directory = mkdtempSync(join(tmpdir(), 'mailbox-migration-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test('mailbox migration preserves deployed data, enforces area uniqueness, and rolls down cleanly', async () => {
  const client = createClient({ url: `file:${join(directory, 'upgrade.sqlite')}` }); const db = drizzle(client)
  const index = migrations.findIndex((migration) => migration.name === '20261005_143605_mailbox_workspace'); expect(index).toBeGreaterThan(0)
  for (const migration of migrations.slice(0, index)) await migration.up({ db } as never)
  const integration = randomUUID(); await client.execute({ sql: 'INSERT INTO integration_configurations (id, provider, model, encrypted_credential, credential_fingerprint, health, monthly_usage_micro_usd) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [integration, 'openai', 'preserved-model', 'ciphertext', 'fingerprint', 'connected', 0] })
  const migration = migrations[index]!; await migration.up({ db } as never)
  const mailbox = randomUUID(); await client.execute({ sql: 'INSERT INTO mailbox_configurations (id, name, provider, primary_address, aliases, host, port, security, username, encrypted_credential, credential_fingerprint, health) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [mailbox, 'Primary', 'smtp', 'hello@example.test', '[]', 'smtp.example.test', 587, 'starttls', 'user', 'encrypted', 'fingerprint', 'unknown'] })
  await client.execute({ sql: 'INSERT INTO mailbox_area_mappings (id, area, mailbox_id, sender_address) VALUES (?, ?, ?, ?)', args: [randomUUID(), 'leads', mailbox, 'hello@example.test'] })
  await expect(client.execute({ sql: 'INSERT INTO mailbox_area_mappings (id, area, mailbox_id, sender_address) VALUES (?, ?, ?, ?)', args: [randomUUID(), 'leads', mailbox, 'hello@example.test'] })).rejects.toThrow()
  await migration.down({ db } as never)
  expect((await client.execute({ sql: 'SELECT model, encrypted_credential FROM integration_configurations WHERE id = ?', args: [integration] })).rows[0]).toMatchObject({ model: 'preserved-model', encrypted_credential: 'ciphertext' })
  expect((await client.execute("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'mailbox_%'")).rows[0]?.count).toBe(0)
  await client.close()
}, 60_000)
