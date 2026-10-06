import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE configured_ai_jobs ADD image_data_url text;`)
  await db.run(sql`CREATE TABLE ai_job_defaults (id text(36) PRIMARY KEY NOT NULL, job_type text NOT NULL, provider text NOT NULL, model text NOT NULL, fallback_provider text, updated_at text NOT NULL, created_at text NOT NULL);`)
  await db.run(sql`CREATE UNIQUE INDEX ai_job_defaults_job_type_idx ON ai_job_defaults (job_type);`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels ADD ai_job_defaults_id text(36) REFERENCES ai_job_defaults(id);`)
  await db.run(sql`CREATE INDEX payload_locked_documents_rels_ai_job_defaults_id_idx ON payload_locked_documents_rels (ai_job_defaults_id);`)
}
export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX payload_locked_documents_rels_ai_job_defaults_id_idx;`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels DROP COLUMN ai_job_defaults_id;`)
  await db.run(sql`DROP INDEX ai_job_defaults_job_type_idx;`)
  await db.run(sql`DROP TABLE ai_job_defaults;`)
  await db.run(sql`ALTER TABLE configured_ai_jobs DROP COLUMN image_data_url;`)
}
