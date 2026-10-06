import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE notification_deliveries (id text(36) PRIMARY KEY NOT NULL, outbox_id text(36) NOT NULL REFERENCES notification_outbox(id), idempotency_key text NOT NULL, recipient text NOT NULL, state text NOT NULL DEFAULT 'queued', attempts numeric NOT NULL DEFAULT 0, next_attempt_at text NOT NULL, lease_token text, lease_expires_at text, provider_message_i_d text, failure_code text, completed_at text, updated_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL);`)
  await db.run(sql`CREATE UNIQUE INDEX notification_deliveries_idempotency_key_idx ON notification_deliveries (idempotency_key);`)
  await db.run(sql`CREATE INDEX notification_deliveries_claim_idx ON notification_deliveries (state, next_attempt_at, lease_expires_at);`)
  await db.run(sql`CREATE INDEX notification_deliveries_outbox_idx ON notification_deliveries (outbox_id);`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels ADD notification_deliveries_id text(36) REFERENCES notification_deliveries(id);`)
  await db.run(sql`CREATE INDEX payload_locked_documents_rels_notification_deliveries_id_idx ON payload_locked_documents_rels (notification_deliveries_id);`)
}
export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX payload_locked_documents_rels_notification_deliveries_id_idx;`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels DROP COLUMN notification_deliveries_id;`)
  await db.run(sql`DROP INDEX notification_deliveries_outbox_idx;`)
  await db.run(sql`DROP INDEX notification_deliveries_claim_idx;`)
  await db.run(sql`DROP TABLE notification_deliveries;`)
}
