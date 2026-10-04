import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

/**
 * Integration configuration shipped in migration 20261003_240000; this migration
 * adds the provider ledger. The unshipped monthly_usage draft had no documented
 * unit, so this migration deliberately does not reinterpret it as money.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`integration_configurations\` ADD \`monthly_cap_micro_usd\` numeric;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` ADD \`monthly_usage_micro_usd\` numeric DEFAULT 0 NOT NULL;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` ADD \`usage_month\` text;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` ADD \`input_micro_usd_per_million_tokens\` numeric;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` ADD \`output_micro_usd_per_million_tokens\` numeric;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` ADD \`pricing_source\` text;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` ADD \`pricing_as_of\` text;`)
  await db.run(sql`CREATE TABLE \`provider_usage_reservations\` (\`id\` text(36) PRIMARY KEY NOT NULL, \`configuration_id\` text(36) NOT NULL REFERENCES integration_configurations(id), \`execution_key\` text NOT NULL, \`usage_month\` text NOT NULL, \`reserved_micro_usd\` numeric NOT NULL, \`settled_micro_usd\` numeric, \`state\` text NOT NULL, \`config_model\` text NOT NULL, \`credential_fingerprint\` text, \`input_micro_usd_per_million_tokens\` numeric NOT NULL, \`output_micro_usd_per_million_tokens\` numeric NOT NULL, \`pricing_source\` text NOT NULL, \`pricing_as_of\` text NOT NULL, \`request_input_tokens\` numeric NOT NULL, \`max_output_tokens\` numeric NOT NULL, \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL);`)
  await db.run(sql`CREATE UNIQUE INDEX \`provider_usage_reservations_execution_key_idx\` ON \`provider_usage_reservations\` (\`execution_key\`);`)
  await db.run(sql`CREATE INDEX \`provider_usage_reservations_configuration_month_idx\` ON \`provider_usage_reservations\` (\`configuration_id\`, \`usage_month\`);`)
  await db.run(sql`CREATE INDEX \`provider_usage_reservations_updated_at_idx\` ON \`provider_usage_reservations\` (\`updated_at\`);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`provider_usage_reservations_id\` text(36) REFERENCES provider_usage_reservations(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_provider_usage_reservations_id_idx\` ON \`payload_locked_documents_rels\` (\`provider_usage_reservations_id\`);`)
}
export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`payload_locked_documents_rels_provider_usage_reservations_id_idx\`;`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` DROP COLUMN \`provider_usage_reservations_id\`;`)
  await db.run(sql`DROP TABLE \`provider_usage_reservations\`;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` DROP COLUMN \`pricing_as_of\`;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` DROP COLUMN \`pricing_source\`;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` DROP COLUMN \`output_micro_usd_per_million_tokens\`;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` DROP COLUMN \`input_micro_usd_per_million_tokens\`;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` DROP COLUMN \`usage_month\`;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` DROP COLUMN \`monthly_usage_micro_usd\`;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` DROP COLUMN \`monthly_cap_micro_usd\`;`)
}
