import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

/** Additive singleton storage; existing published snapshots remain unchanged. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`site_settings\` (
    \`id\` text(36) PRIMARY KEY NOT NULL,
    \`key\` text DEFAULT 'active' NOT NULL,
    \`site_name\` text NOT NULL,
    \`homepage_id_id\` text(36),
    \`default_locale\` text NOT NULL,
    \`organization_type\` text,
    \`logo_id\` text(36),
    \`contact_email\` text,
    \`contact_phone\` text,
    \`seo_description\` text,
    \`contract_version\` text,
    \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    FOREIGN KEY (\`homepage_id_id\`) REFERENCES \`pages\`(\`id\`) ON UPDATE no action ON DELETE set null,
    FOREIGN KEY (\`logo_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE set null
  );`)
  await db.run(sql`CREATE UNIQUE INDEX \`site_settings_key_idx\` ON \`site_settings\` (\`key\`);`)
  await db.run(sql`CREATE INDEX \`site_settings_updated_at_idx\` ON \`site_settings\` (\`updated_at\`);`)
  // Payload's lock table has one nullable relation for every collection.
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`site_settings_id\` text(36) REFERENCES site_settings(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_site_settings_id_idx\` ON \`payload_locked_documents_rels\` (\`site_settings_id\`);`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`payload_locked_documents_rels_site_settings_id_idx\`;`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` DROP COLUMN \`site_settings_id\`;`)
  await db.run(sql`DROP TABLE \`site_settings\`;`)
}
