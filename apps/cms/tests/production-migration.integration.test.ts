import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const cmsRoot = fileURLToPath(new URL('..', import.meta.url))
import { describe, expect, it } from 'vitest'
import { createClient } from '@libsql/client'

const scopedSlugMigration = '20261003_133520_scoped_page_slugs'
const publishQueueMigration = '20261003_160000_publish_queue_correctness'
const inquiryPipelineMigration = '20261003_163801_inquiry_lead_pipeline'
const redirectLifecycleMigration = '20261003_165038_redirect_lifecycle'
const mediaMigration = '20261003_171753_media_library'

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
    const emptySchema = await sqlite.execute("SELECT name FROM pragma_table_info('publish_snapshots') WHERE name IN ('baseline_snapshot_id', 'baseline_sequence')")
    expect(emptySchema.rows.map((row) => row.name)).toEqual(['baseline_snapshot_id', 'baseline_sequence'])
    const emptyIndexes = await sqlite.execute("SELECT name FROM pragma_index_list('publish_snapshots') WHERE name IN ('publish_snapshots_content_hash_idx', 'publish_snapshots_baseline_snapshot_idx')")
    expect(emptyIndexes.rows.map((row) => row.name)).toEqual(['publish_snapshots_baseline_snapshot_idx'])
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

    // Reconstruct the schema at migration 9. The real production command must
    // add the queue baseline fields without a schema push or an empty-db shortcut.
    for (const statement of [
      'DROP INDEX publish_snapshots_baseline_snapshot_idx',
      'ALTER TABLE publish_snapshots DROP COLUMN baseline_snapshot_id',
      'ALTER TABLE publish_snapshots DROP COLUMN baseline_sequence',
      'CREATE UNIQUE INDEX publish_snapshots_content_hash_idx ON publish_snapshots (content_hash)',
      `DELETE FROM payload_migrations WHERE name = '${publishQueueMigration}'`,
    ]) await sqlite.execute(statement)
    const queueForward = migrate()
    expect(queueForward.status, queueForward.stderr || queueForward.stdout).toBe(0)
    const queueColumns = await sqlite.execute("SELECT name, dflt_value FROM pragma_table_info('publish_snapshots') WHERE name IN ('baseline_snapshot_id', 'baseline_sequence')")
    expect(queueColumns.rows).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'baseline_snapshot_id' }), expect.objectContaining({ name: 'baseline_sequence', dflt_value: '0' })]))
    const queueIndexes = await sqlite.execute("SELECT name FROM pragma_index_list('publish_snapshots') WHERE name IN ('publish_snapshots_content_hash_idx', 'publish_snapshots_baseline_snapshot_idx')")
    expect(queueIndexes.rows.map((row) => row.name)).toEqual(['publish_snapshots_baseline_snapshot_idx'])
    const queueApplied = await sqlite.execute(`SELECT name FROM payload_migrations WHERE name = '${publishQueueMigration}'`)
    expect(queueApplied.rows.map((row) => row.name)).toEqual([publishQueueMigration])
    // Recreate the persisted schema and data immediately before the inquiry
    // migration, then run the real production migrator rather than a schema push.
    for (const statement of [
      'DROP TABLE notification_outbox',
      'DROP INDEX payload_locked_documents_rels_notification_outbox_id_idx',
      'ALTER TABLE payload_locked_documents_rels DROP COLUMN notification_outbox_id',
      'PRAGMA foreign_keys=OFF',
      'DROP TABLE inquiries',
      "CREATE TABLE inquiries (id text(36) PRIMARY KEY NOT NULL, email text NOT NULL, message text NOT NULL, status text DEFAULT 'new', updated_at text NOT NULL, created_at text NOT NULL)",
      "INSERT INTO inquiries (id, email, message, status, updated_at, created_at) VALUES ('30000000-0000-4000-8000-000000000001', 'legacy@example.test', 'Synthetic legacy inquiry retained through an upgrade.', 'contacted', '2026-01-03T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
      'PRAGMA foreign_keys=ON',
      `DELETE FROM payload_migrations WHERE name = '${inquiryPipelineMigration}'`,
    ]) await sqlite.execute(statement)
    const inquiryForward = migrate()
    expect(inquiryForward.status, inquiryForward.stderr || inquiryForward.stdout).toBe(0)
    const upgradedInquiry = await sqlite.execute("SELECT email, message, stage, consent_basis, consented_at, idempotency_key FROM inquiries WHERE id = '30000000-0000-4000-8000-000000000001'")
    expect(upgradedInquiry.rows[0]).toMatchObject({ email: 'legacy@example.test', message: 'Synthetic legacy inquiry retained through an upgrade.', stage: 'contacted', consent_basis: 'unknown', consented_at: '2026-01-02T00:00:00.000Z', idempotency_key: 'legacy:30000000-0000-4000-8000-000000000001' })
    const outbox = await sqlite.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_outbox'")
    expect(outbox.rows).toHaveLength(1)
    const inquiryApplied = await sqlite.execute(`SELECT name FROM payload_migrations WHERE name = '${inquiryPipelineMigration}'`)
    expect(inquiryApplied.rows.map((row) => row.name)).toEqual([inquiryPipelineMigration])

    // Reconstruct the schema immediately before redirect lifecycle support and
    // run the real production migrator against that persisted database.
    for (const statement of [
      'ALTER TABLE redirects DROP COLUMN hit_count',
      'ALTER TABLE redirects DROP COLUMN last_hit_at',
      `DELETE FROM payload_migrations WHERE name = '${redirectLifecycleMigration}'`,
    ]) await sqlite.execute(statement)
    const redirectForward = migrate()
    expect(redirectForward.status, redirectForward.stderr || redirectForward.stdout).toBe(0)
    const redirectColumns = await sqlite.execute("SELECT name, dflt_value FROM pragma_table_info('redirects') WHERE name IN ('hit_count', 'last_hit_at')")
    expect(redirectColumns.rows).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'hit_count', dflt_value: '0' }), expect.objectContaining({ name: 'last_hit_at' })]))
    const redirectApplied = await sqlite.execute(`SELECT name FROM payload_migrations WHERE name = '${redirectLifecycleMigration}'`)
    expect(redirectApplied.rows.map((row) => row.name)).toEqual([redirectLifecycleMigration])

    // Reconstruct the exact pre-ENG-014 asset table, including the legacy
    // private bit, then prove the generated rebuild migration retains it.
    for (const statement of [
      'DROP TABLE assets_texts',
      'DROP TABLE assets',
      "CREATE TABLE assets (id text(36) PRIMARY KEY NOT NULL, alt text NOT NULL, caption text, private integer DEFAULT true, updated_at text NOT NULL, created_at text NOT NULL)",
      "INSERT INTO assets (id, alt, caption, private, updated_at, created_at) VALUES ('30000000-0000-4000-8000-000000000001', 'Synthetic legacy asset', 'Legacy metadata', 1, '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')",
      `DELETE FROM payload_migrations WHERE name = '${mediaMigration}'`,
    ]) await sqlite.execute(statement)
    const mediaForward = migrate()
    expect(mediaForward.status, mediaForward.stderr || mediaForward.stdout).toBe(0)
    const legacyAsset = await sqlite.execute("SELECT alt, caption, private, filename FROM assets WHERE id = '30000000-0000-4000-8000-000000000001'")
    expect(legacyAsset.rows[0]).toMatchObject({ alt: 'Synthetic legacy asset', caption: 'Legacy metadata', private: 1, filename: null })
    await sqlite.close()

    const tsxBin = resolve(cmsRoot, 'node_modules/tsx/dist/cli.mjs')
    const verify = spawnSync(process.execPath, [tsxBin, 'scripts/verify-production-migration.ts'], { cwd: cmsRoot, env: environment, encoding: 'utf8' })
    expect(verify.status, verify.stderr || verify.stdout).toBe(0)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 90_000)
})
