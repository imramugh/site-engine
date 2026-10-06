import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createClient } from '@libsql/client'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
test('production migration adds nullable mail attachment descriptors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mail-draft-attachments-migration-'))
  const database = join(directory, 'runtime.sqlite')
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DATABASE_URI: `file:${database}`, PAYLOAD_SECRET: 'mail-draft-attachments-production-secret-long-enough' }
  try {
    const payload = resolve(root, 'node_modules/payload/bin.js')
    const migrated = spawnSync(process.execPath, [payload, 'migrate', '--config', 'payload.config.ts'], { cwd: root, env, encoding: 'utf8' })
    expect(migrated.status, `${migrated.stdout}\n${migrated.stderr}`).toBe(0)
    const db = createClient({ url: `file:${database}` })
    const columns = await db.execute('PRAGMA table_info(mail_drafts)')
    expect(columns.rows.find((column) => column.name === 'attachments')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: "'[]'" })
    await db.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 120_000)
