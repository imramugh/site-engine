import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`retention_settings\` (\`id\` text(36) PRIMARY KEY NOT NULL, \`key\` text NOT NULL, \`spam_days\` numeric DEFAULT 30 NOT NULL, \`media_bin_days\` numeric DEFAULT 30 NOT NULL, \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL);`)
  await db.run(sql`CREATE UNIQUE INDEX \`retention_settings_key_idx\` ON \`retention_settings\` (\`key\`);`)
  await db.run(sql`CREATE TABLE \`deletion_tombstones\` (\`id\` text(36) PRIMARY KEY NOT NULL, \`resource_type\` text NOT NULL, \`resource_id\` text NOT NULL, \`deleted_at\` text NOT NULL, \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL);`)
  await db.run(sql`CREATE UNIQUE INDEX \`deletion_tombstones_resource_idx\` ON \`deletion_tombstones\` (\`resource_type\`, \`resource_id\`);`)
  await db.run(sql`CREATE TABLE \`retention_purge_jobs\` (\`id\` text(36) PRIMARY KEY NOT NULL, \`resource_type\` text NOT NULL, \`resource_id\` text NOT NULL, \`state\` text NOT NULL, \`attempts\` numeric DEFAULT 0 NOT NULL, \`last_error\` text, \`resume_key\` text, \`completed_at\` text, \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL);`)
  await db.run(sql`CREATE INDEX \`retention_purge_jobs_state_idx\` ON \`retention_purge_jobs\` (\`state\`, \`updated_at\`);`)
}
export async function down({ db }: MigrateDownArgs): Promise<void> { await db.run(sql`DROP TABLE \`retention_purge_jobs\`;`); await db.run(sql`DROP TABLE \`deletion_tombstones\`;`); await db.run(sql`DROP TABLE \`retention_settings\`;`) }
