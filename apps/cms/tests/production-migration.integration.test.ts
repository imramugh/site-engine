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
const applicationsMigration = '20261003_181059'
const siteSettingsMigration = '20261003_200100_site_settings'
const searchControlsMigration = '20261003_210000_search_controls'
const styleGuidesMigration = '20261003_220000_style_guides'
const sectionLandingMigration = '20261003_230000_section_landing_page'
const siteIdentityMigration = '20261005_114210_site_identity_navigation_1_5'
const crawlerPolicyMigration = '20261005_164500_crawler_policy_1_7'

describe('production migrations (ENG-036)', () => {
  it('creates Payload tables and supports a production-mode Payload read/write without schema push', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'site-engine-migration-'))
    try {
    const databaseURI = `file:${join(directory, 'cms.sqlite')}`
    const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DATABASE_URI: databaseURI, PAYLOAD_SECRET: 'test-secret-that-is-long-enough-for-payload' }
    const payloadBin = resolve(cmsRoot, 'node_modules/payload/bin.js')
    const tsxBin = resolve(cmsRoot, 'node_modules/tsx/dist/cli.mjs')
    const migrate = () => spawnSync(process.execPath, [payloadBin, 'migrate', '--config', 'payload.config.ts'], { cwd: cmsRoot, env: environment, encoding: 'utf8' })
    const initialMigration = migrate()
    expect(initialMigration.status, initialMigration.stderr || initialMigration.stdout).toBe(0)
    // This process opens the clean CLI-migrated database with NODE_ENV=production,
    // so Payload runs with push:false before fixture rewinds mutate historical tables.
    const verify = spawnSync(process.execPath, [tsxBin, 'scripts/verify-production-migration.ts'], { cwd: cmsRoot, env: environment, encoding: 'utf8' })
    expect(verify.status, verify.stderr || verify.stdout).toBe(0)
    const sqlite = createClient({ url: databaseURI })
    const tables = await sqlite.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'payload_migrations')")
    expect(tables.rows.map((row) => row.name)).toEqual(expect.arrayContaining(['users', 'payload_migrations']))
    const emptySchema = await sqlite.execute("SELECT name FROM pragma_table_info('publish_snapshots') WHERE name IN ('baseline_snapshot_id', 'baseline_sequence')")
    expect(emptySchema.rows.map((row) => row.name)).toEqual(['baseline_snapshot_id', 'baseline_sequence'])
    const emptyIndexes = await sqlite.execute("SELECT name FROM pragma_index_list('publish_snapshots') WHERE name IN ('publish_snapshots_content_hash_idx', 'publish_snapshots_baseline_snapshot_idx')")
    expect(emptyIndexes.rows.map((row) => row.name)).toEqual(['publish_snapshots_baseline_snapshot_idx'])
    // The production-mode verifier above creates the singleton row. Replace it
    // with the historical fixture before reconstructing the pre-identity schema.
    await sqlite.execute('DELETE FROM site_settings')
    await sqlite.execute("INSERT INTO site_settings (id, key, site_name, default_locale, search_enabled, updated_at, created_at) VALUES ('15000000-0000-4000-8000-000000000001', 'active', 'Legacy identity', 'en-CA', 1, '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z')")
    for (const statement of [
      'DROP INDEX site_settings_logos_logos_primary_light_idx', 'DROP INDEX site_settings_logos_logos_primary_dark_idx', 'DROP INDEX site_settings_logos_logos_full_lockup_light_idx', 'DROP INDEX site_settings_logos_logos_full_lockup_dark_idx', 'DROP INDEX site_settings_logos_logos_symbol_light_idx', 'DROP INDEX site_settings_logos_logos_symbol_dark_idx',
      'ALTER TABLE site_settings DROP COLUMN legal_name', 'ALTER TABLE site_settings DROP COLUMN logos_primary_light_id', 'ALTER TABLE site_settings DROP COLUMN logos_primary_dark_id', 'ALTER TABLE site_settings DROP COLUMN logos_full_lockup_light_id', 'ALTER TABLE site_settings DROP COLUMN logos_full_lockup_dark_id', 'ALTER TABLE site_settings DROP COLUMN logos_symbol_light_id', 'ALTER TABLE site_settings DROP COLUMN logos_symbol_dark_id',
      'ALTER TABLE site_settings DROP COLUMN address_street_address', 'ALTER TABLE site_settings DROP COLUMN address_address_locality', 'ALTER TABLE site_settings DROP COLUMN address_address_region', 'ALTER TABLE site_settings DROP COLUMN address_postal_code', 'ALTER TABLE site_settings DROP COLUMN address_address_country', 'ALTER TABLE site_settings DROP COLUMN linked_in', 'ALTER TABLE site_settings DROP COLUMN incident_label', 'ALTER TABLE site_settings DROP COLUMN incident_guidance', 'ALTER TABLE site_settings DROP COLUMN navigation',
      `DELETE FROM payload_migrations WHERE name = '${siteIdentityMigration}'`,
    ]) await sqlite.execute(statement)
    const removedIdentityColumns = await sqlite.execute("SELECT name FROM pragma_table_info('site_settings') WHERE name IN ('legal_name', 'address_street_address', 'incident_label', 'navigation', 'logos_primary_light_id')")
    expect(removedIdentityColumns.rows).toHaveLength(0)
    const retainedLegacyIdentity = await sqlite.execute("SELECT site_name, default_locale, search_enabled FROM site_settings WHERE id = '15000000-0000-4000-8000-000000000001'")
    expect(retainedLegacyIdentity.rows[0]).toMatchObject({ site_name: 'Legacy identity', default_locale: 'en-CA', search_enabled: 1 })
    const identityUp = migrate()
    expect(identityUp.status, identityUp.stderr || identityUp.stdout).toBe(0)
    const restoredIdentityColumns = await sqlite.execute("SELECT name FROM pragma_table_info('site_settings') WHERE name IN ('legal_name', 'address_street_address', 'incident_label', 'navigation', 'logos_primary_light_id')")
    expect(restoredIdentityColumns.rows.map(row => row.name).sort()).toEqual(['address_street_address', 'incident_label', 'legal_name', 'logos_primary_light_id', 'navigation'])
    const upgradedLegacyIdentity = await sqlite.execute("SELECT site_name, legal_name, navigation FROM site_settings WHERE id = '15000000-0000-4000-8000-000000000001'")
    expect(upgradedLegacyIdentity.rows[0]).toMatchObject({ site_name: 'Legacy identity', legal_name: null, navigation: null })
    expect((await sqlite.execute(`SELECT name FROM payload_migrations WHERE name = '${siteIdentityMigration}'`)).rows).toHaveLength(1)
    // Reconstruct the state immediately before the newest migration: all prior
    // migrations are recorded, an existing row uses the old global slug index,
    // and the latest migration has not been recorded yet.
    for (const statement of [
      // The production-mode verifier intentionally created same-slug pages in
      // separate sections. They are not part of this historical fixture, whose
      // old schema has a global unique slug index.
      'DELETE FROM pages',
      'DELETE FROM sections',
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
    // Reconstruct the legacy private-application table and prove the generated
    // expansion preserves a row while assigning collision-free defaults.
    for (const statement of [
      'DROP INDEX applications_idempotency_key_idx',
      'ALTER TABLE applications DROP COLUMN name',
      'ALTER TABLE applications DROP COLUMN consent',
      'ALTER TABLE applications DROP COLUMN job_id',
      'ALTER TABLE applications DROP COLUMN resume_key',
      'ALTER TABLE applications DROP COLUMN idempotency_key',
      "INSERT INTO applications (id, email, cover_letter, status, updated_at, created_at) VALUES ('40000000-0000-4000-8000-000000000001', 'legacy-applicant@example.test', 'Synthetic legacy application retained through upgrade.', 'new', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')",
      `DELETE FROM payload_migrations WHERE name = '${applicationsMigration}'`,
    ]) await sqlite.execute(statement)
    const applicationsForward = migrate()
    expect(applicationsForward.status, applicationsForward.stderr || applicationsForward.stdout).toBe(0)
    const legacyApplication = await sqlite.execute("SELECT name, email, job_id, resume_key, idempotency_key FROM applications WHERE id = '40000000-0000-4000-8000-000000000001'")
    expect(legacyApplication.rows[0]).toMatchObject({ name: 'Legacy applicant', email: 'legacy-applicant@example.test', job_id: 'legacy', resume_key: 'legacy', idempotency_key: 'legacy:40000000-0000-4000-8000-000000000001' })
    await expect(sqlite.execute("INSERT INTO applications (id, name, email, cover_letter, consent, job_id, resume_key, idempotency_key, status, updated_at, created_at) VALUES ('40000000-0000-4000-8000-000000000002', 'New applicant', 'new-applicant@example.test', 'Synthetic new application write after upgrade.', 1, 'job-1', 'key-1', 'new-key', 'new', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')")).resolves.toBeDefined()
    await expect(sqlite.execute("INSERT INTO applications (id, name, email, cover_letter, consent, job_id, resume_key, idempotency_key, status, updated_at, created_at) VALUES ('40000000-0000-4000-8000-000000000003', 'Duplicate applicant', 'duplicate@example.test', 'Synthetic duplicate application write.', 1, 'job-1', 'key-2', 'new-key', 'new', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')")).rejects.toThrow()

    // Reconstruct the pre-singleton database and replay the real migration.
    // This proves upgrades add both the singleton table and Payload's lock
    // relation rather than relying on an empty database schema push.
    for (const statement of [
      'DROP INDEX payload_locked_documents_rels_site_settings_id_idx',
      'ALTER TABLE payload_locked_documents_rels DROP COLUMN site_settings_id',
      'DROP TABLE site_settings',
      `DELETE FROM payload_migrations WHERE name = '${siteSettingsMigration}'`,
      `DELETE FROM payload_migrations WHERE name = '${siteIdentityMigration}'`,
      `DELETE FROM payload_migrations WHERE name = '${crawlerPolicyMigration}'`,
    ]) await sqlite.execute(statement)
    const siteSettingsForward = migrate()
    expect(siteSettingsForward.status, siteSettingsForward.stderr || siteSettingsForward.stdout).toBe(0)
    const siteSettingsColumns = await sqlite.execute("SELECT name FROM pragma_table_info('site_settings') WHERE name IN ('key', 'site_name', 'default_locale')")
    expect(siteSettingsColumns.rows.map((row) => row.name)).toEqual(['key', 'site_name', 'default_locale'])
    const crawlerPolicyColumns = await sqlite.execute("SELECT name FROM pragma_table_info('site_settings') WHERE name = 'crawler_policy'")
    expect(crawlerPolicyColumns.rows.map((row) => row.name)).toEqual(['crawler_policy'])
    const lockColumns = await sqlite.execute("SELECT name FROM pragma_table_info('payload_locked_documents_rels') WHERE name = 'site_settings_id'")
    expect(lockColumns.rows.map((row) => row.name)).toEqual(['site_settings_id'])
    const siteSettingsApplied = await sqlite.execute(`SELECT name FROM payload_migrations WHERE name = '${siteSettingsMigration}'`)
    expect(siteSettingsApplied.rows.map((row) => row.name)).toEqual([siteSettingsMigration])
    const crawlerPolicyApplied = await sqlite.execute(`SELECT name FROM payload_migrations WHERE name = '${crawlerPolicyMigration}'`)
    expect(crawlerPolicyApplied.rows.map((row) => row.name)).toEqual([crawlerPolicyMigration])

    // Reconstruct the persisted schema before reviewed search controls and
    // replay the production migrator. Pages are versioned, so both the live
    // and version tables must receive noindex alongside the singleton flag.
    for (const statement of [
      'ALTER TABLE pages DROP COLUMN noindex',
      'ALTER TABLE _pages_v DROP COLUMN version_noindex',
      `DELETE FROM payload_migrations WHERE name = '${searchControlsMigration}'`,
    ]) await sqlite.execute(statement)
    const searchControlsForward = migrate()
    expect(searchControlsForward.status, searchControlsForward.stderr || searchControlsForward.stdout).toBe(0)
    const searchColumns = await sqlite.execute("SELECT name, dflt_value FROM pragma_table_info('pages') WHERE name = 'noindex'")
    expect(searchColumns.rows).toEqual([expect.objectContaining({ name: 'noindex', dflt_value: 'false' })])
    const versionSearchColumns = await sqlite.execute("SELECT name, dflt_value FROM pragma_table_info('_pages_v') WHERE name = 'version_noindex'")
    expect(versionSearchColumns.rows).toEqual([expect.objectContaining({ name: 'version_noindex', dflt_value: 'false' })])
    const settingsSearchColumns = await sqlite.execute("SELECT name, dflt_value FROM pragma_table_info('site_settings') WHERE name = 'search_enabled'")
    expect(settingsSearchColumns.rows).toEqual([expect.objectContaining({ name: 'search_enabled', dflt_value: 'false' })])
    const searchControlsApplied = await sqlite.execute(`SELECT name FROM payload_migrations WHERE name = '${searchControlsMigration}'`)
    expect(searchControlsApplied.rows.map((row) => row.name)).toEqual([searchControlsMigration])
    for (const statement of [
      'DROP INDEX payload_locked_documents_rels_style_guides_id_idx',
      'ALTER TABLE payload_locked_documents_rels DROP COLUMN style_guides_id',
      'DROP TABLE style_guides',
      `DELETE FROM payload_migrations WHERE name = '${styleGuidesMigration}'`,
    ]) await sqlite.execute(statement)
    expect(migrate().status).toBe(0)
    expect((await sqlite.execute("SELECT name FROM pragma_table_info('style_guides') WHERE name = 'key'")).rows).toHaveLength(1)
    for (const statement of [
      'DROP INDEX sections_landing_page_id_idx',
      'ALTER TABLE sections DROP COLUMN landing_page_id_id',
      'DROP INDEX _sections_v_version_landing_page_id_idx',
      'ALTER TABLE _sections_v DROP COLUMN version_landing_page_id_id',
      `DELETE FROM payload_migrations WHERE name = '${sectionLandingMigration}'`,
    ]) await sqlite.execute(statement)
    const landingForward = migrate()
    expect(landingForward.status, landingForward.stderr || landingForward.stdout).toBe(0)
    expect((await sqlite.execute("SELECT name FROM pragma_table_info('sections') WHERE name = 'landing_page_id_id'")).rows).toHaveLength(1)
    expect((await sqlite.execute("SELECT name FROM pragma_table_info('_sections_v') WHERE name = 'version_landing_page_id_id'")).rows).toHaveLength(1)
    expect((await sqlite.execute(`SELECT name FROM payload_migrations WHERE name = '${sectionLandingMigration}'`)).rows).toHaveLength(1)
    await sqlite.close()

    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 120_000)
})
