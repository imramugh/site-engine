import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`configured_ai_jobs\` (\`id\` text(36) PRIMARY KEY NOT NULL, \`actor_id\` text(36) NOT NULL REFERENCES users(id), \`idempotency_key\` text NOT NULL, \`request_digest\` text NOT NULL, \`input\` text NOT NULL, \`provider\` text NOT NULL, \`fallback_provider\` text, \`max_output_tokens\` numeric NOT NULL, \`configuration_snapshot\` text NOT NULL, \`state\` text NOT NULL, \`lease_token\` text, \`lease_expires_at\` text, \`dispatch_started_at\` text, \`result\` text, \`result_digest\` text, \`cost_status\` text, \`used_provider\` text, \`fallback_used\` numeric DEFAULT false, \`failure_code\` text, \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL);`)
  await db.run(sql`CREATE UNIQUE INDEX \`configured_ai_jobs_idempotency_key_idx\` ON \`configured_ai_jobs\` (\`idempotency_key\`);`)
  await db.run(sql`CREATE INDEX \`configured_ai_jobs_state_idx\` ON \`configured_ai_jobs\` (\`state\`, \`created_at\`);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`configured_ai_jobs_id\` text(36) REFERENCES configured_ai_jobs(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_configured_ai_jobs_id_idx\` ON \`payload_locked_documents_rels\` (\`configured_ai_jobs_id\`);`)
}
export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`payload_locked_documents_rels_configured_ai_jobs_id_idx\`;`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` DROP COLUMN \`configured_ai_jobs_id\`;`)
  await db.run(sql`DROP TABLE \`configured_ai_jobs\`;`)
}
