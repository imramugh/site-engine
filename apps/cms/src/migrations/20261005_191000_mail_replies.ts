import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

// SQLite cannot relax a NOT NULL relation in place. Preserve every existing
// draft and add the application relation while rebuilding the small local table.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  // Preserve children explicitly: SQLite executes ON DELETE actions immediately
  // even when checks are deferred inside Payload's migration transaction.
  await db.run(sql`CREATE TEMP TABLE retention_mail_locks AS SELECT * FROM payload_locked_documents_rels WHERE mail_drafts_id IS NOT NULL OR mail_authorizations_id IS NOT NULL;`)
  await db.run(sql`CREATE TABLE mail_drafts_next (id text(36) PRIMARY KEY NOT NULL, lead_id text(36) REFERENCES inquiries(id), application_id text(36) REFERENCES applications(id), thread_i_d text NOT NULL, recipient text NOT NULL, sender text NOT NULL, subject text NOT NULL, body text NOT NULL, attachment_hashes text DEFAULT '[]', revision numeric NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'prepared', updated_at text NOT NULL, created_at text NOT NULL, CHECK ((lead_id IS NOT NULL) != (application_id IS NOT NULL)));`)
  await db.run(sql`INSERT INTO mail_drafts_next (id,lead_id,thread_i_d,recipient,sender,subject,body,attachment_hashes,revision,state,updated_at,created_at) SELECT id,lead_id,thread_i_d,recipient,sender,subject,body,attachment_hashes,revision,state,updated_at,created_at FROM mail_drafts;`)
  await db.run(sql`CREATE TABLE mail_authorizations_next (id text(36) PRIMARY KEY NOT NULL, draft_id text(36) NOT NULL REFERENCES mail_drafts_next(id), digest text NOT NULL, draft_revision numeric NOT NULL, authorized_by_id text(36) NOT NULL REFERENCES users(id), expires_at text NOT NULL, revoked_at text, consumed_at text, updated_at text NOT NULL, created_at text NOT NULL);`)
  await db.run(sql`INSERT INTO mail_authorizations_next SELECT * FROM mail_authorizations;`)
  await db.run(sql`DROP TABLE mail_authorizations;`)
  await db.run(sql`ALTER TABLE mail_authorizations_next RENAME TO mail_authorizations;`)
  await db.run(sql`DROP TABLE mail_drafts;`)
  await db.run(sql`ALTER TABLE mail_drafts_next RENAME TO mail_drafts;`)
  await db.run(sql`INSERT INTO payload_locked_documents_rels (\`order\`,parent_id,path,mail_drafts_id,mail_authorizations_id) SELECT \`order\`,parent_id,path,mail_drafts_id,mail_authorizations_id FROM retention_mail_locks;`)
  await db.run(sql`CREATE INDEX mail_drafts_lead_idx ON mail_drafts (lead_id);`)
  await db.run(sql`CREATE INDEX mail_drafts_application_idx ON mail_drafts (application_id);`)
}
export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DELETE FROM mail_authorizations WHERE draft_id IN (SELECT id FROM mail_drafts WHERE application_id IS NOT NULL);`)
  await db.run(sql`DELETE FROM mail_drafts WHERE application_id IS NOT NULL;`)
  await db.run(sql`CREATE TEMP TABLE retention_mail_locks_down AS SELECT * FROM payload_locked_documents_rels WHERE mail_drafts_id IS NOT NULL OR mail_authorizations_id IS NOT NULL;`)
  await db.run(sql`CREATE TABLE mail_drafts_previous (id text(36) PRIMARY KEY NOT NULL, lead_id text(36) NOT NULL REFERENCES inquiries(id), thread_i_d text NOT NULL, recipient text NOT NULL, sender text NOT NULL, subject text NOT NULL, body text NOT NULL, attachment_hashes text DEFAULT '[]', revision numeric NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'prepared', updated_at text NOT NULL, created_at text NOT NULL);`)
  await db.run(sql`INSERT INTO mail_drafts_previous (id,lead_id,thread_i_d,recipient,sender,subject,body,attachment_hashes,revision,state,updated_at,created_at) SELECT id,lead_id,thread_i_d,recipient,sender,subject,body,attachment_hashes,revision,state,updated_at,created_at FROM mail_drafts;`)
  await db.run(sql`CREATE TABLE mail_authorizations_previous (id text(36) PRIMARY KEY NOT NULL, draft_id text(36) NOT NULL REFERENCES mail_drafts_previous(id), digest text NOT NULL, draft_revision numeric NOT NULL, authorized_by_id text(36) NOT NULL REFERENCES users(id), expires_at text NOT NULL, revoked_at text, consumed_at text, updated_at text NOT NULL, created_at text NOT NULL);`)
  await db.run(sql`INSERT INTO mail_authorizations_previous SELECT * FROM mail_authorizations;`)
  await db.run(sql`DROP TABLE mail_authorizations;`)
  await db.run(sql`ALTER TABLE mail_authorizations_previous RENAME TO mail_authorizations;`)
  await db.run(sql`DROP TABLE mail_drafts;`)
  await db.run(sql`ALTER TABLE mail_drafts_previous RENAME TO mail_drafts;`)
  await db.run(sql`INSERT INTO payload_locked_documents_rels (\`order\`,parent_id,path,mail_drafts_id,mail_authorizations_id) SELECT \`order\`,parent_id,path,mail_drafts_id,mail_authorizations_id FROM retention_mail_locks_down;`)
  await db.run(sql`CREATE INDEX mail_drafts_lead_idx ON mail_drafts (lead_id);`)
}
