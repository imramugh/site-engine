import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`integration_configurations\` (\`id\` text(36) PRIMARY KEY NOT NULL, \`provider\` text NOT NULL, \`model\` text NOT NULL, \`fallback_provider\` text, \`monthly_cap\` numeric, \`encrypted_credential\` text, \`credential_fingerprint\` text, \`health\` text DEFAULT 'unknown' NOT NULL, \`tested_at\` text, \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL);`)
  await db.run(sql`CREATE UNIQUE INDEX \`integration_configurations_provider_idx\` ON \`integration_configurations\` (\`provider\`);`)
  await db.run(sql`CREATE INDEX \`integration_configurations_updated_at_idx\` ON \`integration_configurations\` (\`updated_at\`);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`integration_configurations_id\` text(36) REFERENCES integration_configurations(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_integration_configurations_id_idx\` ON \`payload_locked_documents_rels\` (\`integration_configurations_id\`);`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`payload_locked_documents_rels_integration_configurations_id_idx\`;`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` DROP COLUMN \`integration_configurations_id\`;`)
  await db.run(sql`DROP TABLE \`integration_configurations\`;`)
}
