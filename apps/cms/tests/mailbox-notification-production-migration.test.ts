import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { afterAll, describe, expect, it } from 'vitest'
import { migrations } from '../src/migrations/index.js'

const directory = mkdtempSync(join(tmpdir(), 'mailbox-production-upgrade-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('ENG-020 production mailbox upgrade', () => {
  it('preserves legacy credentials and sender proof through upgrade, rollback and re-upgrade', async () => {
    const client = createClient({ url: `file:${join(directory, 'upgrade.sqlite')}` })
    const db = drizzle(client)
    try {
      const index = migrations.findIndex(item => item.name === '20261011_040000_mailbox_notifications')
      expect(index).toBeGreaterThan(0)
      const target = migrations[index]!
      for (const [batch, migration] of migrations.slice(0, index).entries()) {
        await migration.up({ db } as never)
        await client.execute({ sql: 'INSERT INTO payload_migrations (id, name, batch) VALUES (?, ?, ?)', args: [randomUUID(), migration.name, batch] })
      }
      const mailbox = randomUUID(); const envelope = 'v1.encrypted-legacy-envelope'
      await client.execute({ sql: 'INSERT INTO mailbox_configurations (id, name, provider, primary_address, aliases, verified_aliases, encrypted_credential, credential_revision, health, host, port, security, username) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [mailbox, 'Shared mailbox', 'microsoft', 'staff@example.com', '["sales@example.com"]', '["sales@example.com"]', envelope, 'original-revision', 'connected', 'outlook.office365.com', 443, 'tls', 'staff@example.com'] })
      for (let round = 0; round < 2; round += 1) {
        await target.up({ db } as never)
        expect((await client.execute({ sql: 'SELECT connection_mode, encrypted_credential, credential_revision, verified_aliases FROM mailbox_configurations WHERE id = ?', args: [mailbox] })).rows[0]).toMatchObject({ connection_mode: 'delegated', encrypted_credential: envelope, credential_revision: 'original-revision', verified_aliases: '["sales@example.com"]' })
        const notification = randomUUID(); const now = new Date().toISOString()
        await client.execute({ sql: 'INSERT INTO mailbox_notifications (id, mailbox_id, provider, credential_revision, status, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [notification, mailbox, 'microsoft', 'original-revision', 'active', now, now] })
        expect((await client.execute({ sql: 'SELECT renew_failure_count FROM mailbox_notifications WHERE id = ?', args: [notification] })).rows[0]).toMatchObject({ renew_failure_count: 0 })
        await expect(client.execute({ sql: 'INSERT INTO mailbox_notifications (id, mailbox_id, provider, credential_revision, status, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [randomUUID(), mailbox, 'microsoft', 'original-revision', 'active', now, now] })).rejects.toThrow()
        await target.down({ db } as never)
        expect((await client.execute("SELECT name FROM pragma_table_info('mailbox_configurations') WHERE name = 'connection_mode'")).rows).toHaveLength(0)
        expect((await client.execute({ sql: 'SELECT encrypted_credential, verified_aliases FROM mailbox_configurations WHERE id = ?', args: [mailbox] })).rows[0]).toMatchObject({ encrypted_credential: envelope, verified_aliases: '["sales@example.com"]' })
      }
    } finally { client.close() }
  }, 60_000)
})
