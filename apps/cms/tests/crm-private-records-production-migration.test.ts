import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

test('production CLI migration persists nullable application notes and private external replies with push disabled', () => {
  const directory = mkdtempSync(join(tmpdir(), 'crm-private-records-production-'))
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DATABASE_URI: `file:${join(directory, 'runtime.sqlite')}`, PAYLOAD_SECRET: 'crm-private-records-production-secret-long-enough' }
  try {
    const migrate = spawnSync(process.execPath, [resolve(root, 'node_modules/payload/bin.js'), 'migrate', '--config', 'payload.config.ts'], { cwd: root, env, encoding: 'utf8' })
    expect(migrate.status, migrate.stderr || migrate.stdout).toBe(0)
    const probe = spawnSync(process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'), 'scripts/verify-crm-private-records-migration.ts'], { cwd: root, env, encoding: 'utf8' })
    expect(probe.status, probe.stderr || probe.stdout).toBe(0)
    expect(probe.stdout).toContain('CRM private records production persistence, uniqueness, and rollback guard verified')
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 120_000)
