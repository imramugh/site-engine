import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
test('production migration creates durable mailbox inbound cursor fields with push disabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailbox-inbound-cursor-production-'))
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DATABASE_URI: `file:${join(dir, 'runtime.sqlite')}`, PAYLOAD_SECRET: 'mailbox-inbound-cursor-production-secret-long-enough', INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url') }
  try {
    const payload = resolve(root, 'node_modules/payload/bin.js'); const tsx = resolve(root, 'node_modules/tsx/dist/cli.mjs')
    const migrated = spawnSync(process.execPath, [payload, 'migrate', '--config', 'payload.config.ts'], { cwd: root, env, encoding: 'utf8' })
    expect(migrated.status, `${migrated.stdout}\n${migrated.stderr}`).toBe(0)
    const probe = spawnSync(process.execPath, [tsx, 'scripts/verify-mailbox-inbound-cursor-migration.ts'], { cwd: root, env, encoding: 'utf8' })
    expect(probe.status, probe.stderr || probe.stdout).toBe(0)
    expect(probe.stdout).toContain('mailbox inbound cursor production CRUD')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 120_000)
