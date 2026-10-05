import { sql, type MigrateUpArgs, type MigrateDownArgs } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs) {
  await db.run(sql`CREATE TABLE mail_threads (id text(36) PRIMARY KEY NOT NULL, lead_id text(36) REFERENCES inquiries(id), application_id text(36) REFERENCES applications(id), mailbox_id text(36) NOT NULL REFERENCES mailbox_configurations(id), provider text NOT NULL, provider_conversation_i_d text NOT NULL, updated_at text NOT NULL, created_at text NOT NULL, CHECK ((lead_id IS NOT NULL) != (application_id IS NOT NULL)));`)
  await db.run(sql`CREATE UNIQUE INDEX mail_threads_mailbox_provider_conversation_idx ON mail_threads (mailbox_id, provider, provider_conversation_i_d);`)
  await db.run(sql`CREATE INDEX mail_threads_lead_idx ON mail_threads (lead_id);`)
  await db.run(sql`CREATE INDEX mail_threads_application_idx ON mail_threads (application_id);`)
  await db.run(sql`CREATE TABLE mail_thread_messages (id text(36) PRIMARY KEY NOT NULL, thread_id text(36) NOT NULL REFERENCES mail_threads(id), mailbox_id text(36) NOT NULL REFERENCES mailbox_configurations(id), lead_id text(36) REFERENCES inquiries(id), application_id text(36) REFERENCES applications(id), provider_message_i_d text NOT NULL, direction text NOT NULL, sender text NOT NULL, recipient text NOT NULL, subject text NOT NULL, body text NOT NULL, received_at text NOT NULL, attachment_metadata text DEFAULT '[]', updated_at text NOT NULL, created_at text NOT NULL, CHECK ((lead_id IS NOT NULL) != (application_id IS NOT NULL)));`)
  await db.run(sql`CREATE UNIQUE INDEX mail_thread_messages_mailbox_provider_message_idx ON mail_thread_messages (mailbox_id, provider_message_i_d);`)
  await db.run(sql`CREATE INDEX mail_thread_messages_thread_idx ON mail_thread_messages (thread_id);`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels ADD mail_threads_id text(36) REFERENCES mail_threads(id);`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels ADD mail_thread_messages_id text(36) REFERENCES mail_thread_messages(id);`)
  await db.run(sql`CREATE INDEX payload_locked_documents_rels_mail_threads_id_idx ON payload_locked_documents_rels (mail_threads_id);`)
  await db.run(sql`CREATE INDEX payload_locked_documents_rels_mail_thread_messages_id_idx ON payload_locked_documents_rels (mail_thread_messages_id);`)
}
export async function down({ db }: MigrateDownArgs) {
  // SQLite keeps indexes and foreign-key metadata attached to these columns.
  // Remove them before dropping the referenced collections so a down/up cycle
  // leaves the Payload lock table in the same shape as a fresh migration.
  await db.run(sql`DROP INDEX payload_locked_documents_rels_mail_thread_messages_id_idx;`)
  await db.run(sql`DROP INDEX payload_locked_documents_rels_mail_threads_id_idx;`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels DROP COLUMN mail_thread_messages_id;`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels DROP COLUMN mail_threads_id;`)
  await db.run(sql`DROP TABLE mail_thread_messages;`)
  await db.run(sql`DROP TABLE mail_threads;`)
}
