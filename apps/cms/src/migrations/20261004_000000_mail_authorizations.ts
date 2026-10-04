import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE mail_drafts (id text(36) PRIMARY KEY NOT NULL, lead_id text(36) NOT NULL REFERENCES inquiries(id), thread_i_d text NOT NULL, recipient text NOT NULL, sender text NOT NULL, subject text NOT NULL, body text NOT NULL, attachment_hashes text DEFAULT '[]', revision numeric NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'prepared', updated_at text NOT NULL, created_at text NOT NULL);`)
  await db.run(sql`CREATE INDEX mail_drafts_lead_idx ON mail_drafts (lead_id);`)
  await db.run(sql`CREATE TABLE mail_authorizations (id text(36) PRIMARY KEY NOT NULL, draft_id text(36) NOT NULL REFERENCES mail_drafts(id), digest text NOT NULL, draft_revision numeric NOT NULL, authorized_by_id text(36) NOT NULL REFERENCES users(id), expires_at text NOT NULL, revoked_at text, consumed_at text, updated_at text NOT NULL, created_at text NOT NULL);`)
  await db.run(sql`CREATE INDEX mail_authorizations_draft_idx ON mail_authorizations (draft_id);`)
  // Payload's document lock relation is polymorphic and must gain columns for
  // every new collection, otherwise an unrelated Local API update fails while
  // it checks locks on a migrated production database.
  await db.run(sql`ALTER TABLE payload_locked_documents_rels ADD mail_drafts_id text(36) REFERENCES mail_drafts(id);`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels ADD mail_authorizations_id text(36) REFERENCES mail_authorizations(id);`)
  await db.run(sql`CREATE INDEX payload_locked_documents_rels_mail_drafts_id_idx ON payload_locked_documents_rels (mail_drafts_id);`)
  await db.run(sql`CREATE INDEX payload_locked_documents_rels_mail_authorizations_id_idx ON payload_locked_documents_rels (mail_authorizations_id);`)
}
export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX payload_locked_documents_rels_mail_authorizations_id_idx;`)
  await db.run(sql`DROP INDEX payload_locked_documents_rels_mail_drafts_id_idx;`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels DROP COLUMN mail_authorizations_id;`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels DROP COLUMN mail_drafts_id;`)
  await db.run(sql`DROP TABLE mail_authorizations;`)
  await db.run(sql`DROP TABLE mail_drafts;`)
}
