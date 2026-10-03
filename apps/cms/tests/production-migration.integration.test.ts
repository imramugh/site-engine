import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const cmsRoot = fileURLToPath(new URL('..', import.meta.url))
import { describe, expect, it } from 'vitest'
import { createClient } from '@libsql/client'

const scopedSlugMigration = '20261003_133520_scoped_page_slugs'

describe('production migrations (ENG-036)', () => {
  it('creates Payload tables and supports a production-mode Payload read/write without schema push', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'site-engine-migration-'))
    try {
    const databaseURI = `file:${join(directory, 'cms.sqlite')}`
    const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DATABASE_URI: databaseURI, PAYLOAD_SECRET: 'test-secret-that-is-long-enough-for-payload' }
    const payloadBin = resolve(cmsRoot, 'node_modules/payload/bin.js')
    const migrate = () => spawnSync(process.execPath, [payloadBin, 'migrate', '--config', 'payload.config.ts'], { cwd: cmsRoot, env: environment, encoding: 'utf8' })
    const initialMigration = migrate()
    expect(initialMigration.status, initialMigration.stderr || initialMigration.stdout).toBe(0)
    const sqlite = createClient({ url: databaseURI })
    const tables = await sqlite.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'payload_migrations')")
    expect(tables.rows.map((row) => row.name)).toEqual(expect.arrayContaining(['users', 'payload_migrations']))
    // Reconstruct the state immediately before the newest migration: all prior
    // migrations are recorded, an existing row uses the old global slug index,
    // and the latest migration has not been recorded yet.
    for (const statement of [
      'DROP INDEX pages_section_parent_slug_idx',
      'CREATE UNIQUE INDEX pages_slug_idx ON pages (slug)',
      "INSERT INTO sections (id, name, summary, slug) VALUES ('10000000-0000-4000-8000-000000000001', 'Legacy one', 'Synthetic legacy section used to prove the page slug migration preserves existing content.', 'legacy-one')",
      "INSERT INTO pages (id, title, slug, section_id_id, summary, template, blocks) VALUES ('20000000-0000-4000-8000-000000000001', 'Legacy page', 'legacy-shared', '10000000-0000-4000-8000-000000000001', 'Synthetic legacy page used to prove the page slug migration preserves existing content.', 'standard', '[]')",
      `DELETE FROM payload_migrations WHERE name = '${scopedSlugMigration}'`,
    ]) await sqlite.execute(statement)
    const forwardMigration = migrate()
    expect(forwardMigration.status, forwardMigration.stderr || forwardMigration.stdout).toBe(0)
    const indexes = await sqlite.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('pages_slug_idx', 'pages_section_parent_slug_idx')")
    expect(indexes.rows.map((row) => row.name)).toEqual(['pages_section_parent_slug_idx'])
    const retained = await sqlite.execute("SELECT id FROM pages WHERE id = '20000000-0000-4000-8000-000000000001'")
    expect(retained.rows).toHaveLength(1)
    const applied = await sqlite.execute(`SELECT name FROM payload_migrations WHERE name = '${scopedSlugMigration}'`)
    expect(applied.rows.map((row) => row.name)).toEqual([scopedSlugMigration])
    await sqlite.close()

    const tsxBin = resolve(cmsRoot, 'node_modules/tsx/dist/cli.mjs')
    const verify = spawnSync(process.execPath, [tsxBin, 'scripts/verify-production-migration.ts'], { cwd: cmsRoot, env: environment, encoding: 'utf8' })
    expect(verify.status, verify.stderr || verify.stdout).toBe(0)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 30_000)
})
