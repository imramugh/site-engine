import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
test('production CLI migration supports mail thread runtime CRUD with push disabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-thread-production-'))
  const env = { ...process.env, NODE_ENV: 'production', DATABASE_URI: `file:${join(dir, 'runtime.sqlite')}`, PAYLOAD_SECRET: 'production-probe-secret-long-enough' }
  try {
    const payload = resolve(root, 'node_modules/payload/bin.js'); const tsx = resolve(root, 'node_modules/tsx/dist/cli.mjs')
    const migrate = spawnSync(process.execPath, [payload, 'migrate', '--config', 'payload.config.ts'], { cwd: root, env, encoding: 'utf8' }); expect(migrate.status, migrate.stderr).toBe(0)
    const probe = spawnSync(process.execPath, [tsx, 'scripts/verify-mail-thread-migration.ts'], { cwd: root, env, encoding: 'utf8' }); expect(probe.status, probe.stderr || probe.stdout).toBe(0); expect(probe.stdout).toContain('mail-thread production CRUD')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 120_000)
