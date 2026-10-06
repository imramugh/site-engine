import { sql, type MigrateDownArgs, type MigrateUpArgs } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs) {
  await db.run(sql`CREATE TABLE mail_conversation_suggestions (id text(36) PRIMARY KEY NOT NULL, mailbox_id text(36) NOT NULL REFERENCES mailbox_configurations(id), provider text NOT NULL, provider_conversation_i_d text NOT NULL, address_hash text NOT NULL, target text NOT NULL, adopted_at text, adopted_by_id text(36) REFERENCES users(id), updated_at text NOT NULL, created_at text NOT NULL);`)
  await db.run(sql`CREATE UNIQUE INDEX mail_conversation_suggestions_conversation_target_idx ON mail_conversation_suggestions (mailbox_id, provider, provider_conversation_i_d, target);`)
  await db.run(sql`CREATE INDEX mail_conversation_suggestions_target_idx ON mail_conversation_suggestions (target, address_hash);`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels ADD mail_conversation_suggestions_id text(36) REFERENCES mail_conversation_suggestions(id);`)
  await db.run(sql`CREATE INDEX payload_locked_documents_rels_mail_conversation_suggestions_id_idx ON payload_locked_documents_rels (mail_conversation_suggestions_id);`)
}
export async function down({ db }: MigrateDownArgs) {
  await db.run(sql`DROP INDEX payload_locked_documents_rels_mail_conversation_suggestions_id_idx;`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels DROP COLUMN mail_conversation_suggestions_id;`)
  await db.run(sql`DROP TABLE mail_conversation_suggestions;`)
}
