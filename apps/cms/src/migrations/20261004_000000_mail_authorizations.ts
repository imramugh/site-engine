import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE mail_drafts (id text(36) PRIMARY KEY NOT NULL, lead_id text(36) NOT NULL REFERENCES inquiries(id), thread_i_d text NOT NULL, recipient text NOT NULL, sender text NOT NULL, subject text NOT NULL, body text NOT NULL, attachment_hashes text DEFAULT '[]', revision numeric NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'prepared', updated_at text NOT NULL, created_at text NOT NULL);`)
  await db.run(sql`CREATE INDEX mail_drafts_lead_idx ON mail_drafts (lead_id);`)
  await db.run(sql`CREATE TABLE mail_authorizations (id text(36) PRIMARY KEY NOT NULL, draft_id text(36) NOT NULL REFERENCES mail_drafts(id), digest text NOT NULL UNIQUE, draft_revision numeric NOT NULL, authorized_by_id text(36) NOT NULL REFERENCES users(id), expires_at text NOT NULL, revoked_at text, consumed_at text, updated_at text NOT NULL, created_at text NOT NULL);`)
  await db.run(sql`CREATE INDEX mail_authorizations_draft_idx ON mail_authorizations (draft_id);`)
}
export async function down({ db }: MigrateDownArgs): Promise<void> { await db.run(sql`DROP TABLE mail_authorizations;`); await db.run(sql`DROP TABLE mail_drafts;`) }
