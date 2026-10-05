import { sql, type MigrateDownArgs, type MigrateUpArgs } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs) {
  await db.run(sql`CREATE TABLE mcp_privacy_settings (id text(36) PRIMARY KEY NOT NULL, key text NOT NULL, hide_phone integer DEFAULT true NOT NULL, updated_at text NOT NULL, created_at text NOT NULL);`)
  await db.run(sql`CREATE UNIQUE INDEX mcp_privacy_settings_key_idx ON mcp_privacy_settings (key);`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels ADD mcp_privacy_settings_id text(36) REFERENCES mcp_privacy_settings(id);`)
  await db.run(sql`CREATE INDEX payload_locked_documents_rels_mcp_privacy_settings_id_idx ON payload_locked_documents_rels (mcp_privacy_settings_id);`)
}

export async function down({ db }: MigrateDownArgs) {
  await db.run(sql`DROP TABLE mcp_privacy_settings;`)
}
