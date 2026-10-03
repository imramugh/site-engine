import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const cmsRoot = fileURLToPath(new URL('..', import.meta.url))
import { describe, expect, it } from 'vitest'
import { createClient } from '@libsql/client'

describe('production migrations (ENG-036)', () => {
  it('creates Payload tables and supports a production-mode Payload read/write without schema push', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'site-engine-migration-'))
    try {
    const databaseURI = `file:${join(directory, 'cms.sqlite')}`
    const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DATABASE_URI: databaseURI, PAYLOAD_SECRET: 'test-secret-that-is-long-enough-for-payload' }
    const payloadBin = resolve(cmsRoot, 'node_modules/payload/bin.js')
    const migrate = spawnSync(process.execPath, [payloadBin, 'migrate', '--config', 'payload.config.ts'], { cwd: cmsRoot, env: environment, encoding: 'utf8' })
    expect(migrate.status, migrate.stderr || migrate.stdout).toBe(0)
    const sqlite = createClient({ url: databaseURI })
    const tables = await sqlite.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'payload_migrations')")
    expect(tables.rows.map((row) => row.name)).toEqual(expect.arrayContaining(['users', 'payload_migrations']))
    await sqlite.close()
    const tsxBin = resolve(cmsRoot, 'node_modules/tsx/dist/cli.mjs')
    const verify = spawnSync(process.execPath, [tsxBin, 'scripts/verify-production-migration.ts'], { cwd: cmsRoot, env: environment, encoding: 'utf8' })
    expect(verify.status, verify.stderr || verify.stdout).toBe(0)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 30_000)
})
