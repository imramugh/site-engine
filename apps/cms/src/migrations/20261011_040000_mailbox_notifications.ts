import { sql, type MigrateDownArgs, type MigrateUpArgs } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs) {
  await db.run(sql`ALTER TABLE mailbox_configurations ADD connection_mode text DEFAULT 'delegated';`)
  await db.run(sql`ALTER TABLE mailbox_configurations ADD tenant_i_d text;`)
  await db.run(sql`ALTER TABLE mailbox_configurations ADD client_i_d text;`)
  await db.run(sql`ALTER TABLE mailbox_configurations ADD mailbox_address text;`)
  await db.run(sql`ALTER TABLE mail_thread_messages ADD message_link text;`)
  await db.run(sql`CREATE TABLE mailbox_notifications (id text(36) PRIMARY KEY NOT NULL, mailbox_id text(36) NOT NULL REFERENCES mailbox_configurations(id) ON DELETE SET NULL, provider text NOT NULL, credential_revision text NOT NULL, subscription_i_d text, client_state_hash text, resource text, topic text, expires_at text, status text NOT NULL, last_notification_at text, last_renewed_at text, failure_code text, replay_key text, renew_failure_count numeric DEFAULT 0, next_renew_attempt_at text, updated_at text NOT NULL, created_at text NOT NULL);`)
  await db.run(sql`CREATE UNIQUE INDEX mailbox_notifications_mailbox_idx ON mailbox_notifications (mailbox_id);`)
  await db.run(sql`CREATE INDEX mailbox_notifications_updated_at_idx ON mailbox_notifications (updated_at);`)
  await db.run(sql`CREATE INDEX mailbox_notifications_created_at_idx ON mailbox_notifications (created_at);`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels ADD mailbox_notifications_id text(36) REFERENCES mailbox_notifications(id);`)
  await db.run(sql`CREATE INDEX payload_locked_documents_rels_mailbox_notifications_id_idx ON payload_locked_documents_rels (mailbox_notifications_id);`)
}

export async function down({ db }: MigrateDownArgs) {
  await db.run(sql`DROP INDEX payload_locked_documents_rels_mailbox_notifications_id_idx;`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels DROP COLUMN mailbox_notifications_id;`)
  await db.run(sql`DROP TABLE mailbox_notifications;`)
  await db.run(sql`ALTER TABLE mail_thread_messages DROP COLUMN message_link;`)
  await db.run(sql`ALTER TABLE mailbox_configurations DROP COLUMN mailbox_address;`)
  await db.run(sql`ALTER TABLE mailbox_configurations DROP COLUMN client_i_d;`)
  await db.run(sql`ALTER TABLE mailbox_configurations DROP COLUMN tenant_i_d;`)
  await db.run(sql`ALTER TABLE mailbox_configurations DROP COLUMN connection_mode;`)
}
