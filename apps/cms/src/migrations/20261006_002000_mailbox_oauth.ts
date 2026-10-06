import { sql, type MigrateDownArgs, type MigrateUpArgs } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs) {
  await db.run(sql`CREATE TABLE mailbox_oauth_transactions (id text(36) PRIMARY KEY NOT NULL, provider text NOT NULL, state_hash text NOT NULL, session_hash text NOT NULL, verifier text NOT NULL, owner_id text(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at text NOT NULL, consumed_at text, updated_at text NOT NULL, created_at text NOT NULL);`)
  await db.run(sql`CREATE UNIQUE INDEX mailbox_oauth_transactions_state_hash_idx ON mailbox_oauth_transactions (state_hash);`)
  await db.run(sql`CREATE INDEX mailbox_oauth_transactions_expires_at_idx ON mailbox_oauth_transactions (expires_at);`)
  await db.run(sql`CREATE INDEX mailbox_oauth_transactions_updated_at_idx ON mailbox_oauth_transactions (updated_at);`)
  await db.run(sql`CREATE INDEX mailbox_oauth_transactions_created_at_idx ON mailbox_oauth_transactions (created_at);`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels ADD mailbox_oauth_transactions_id text(36) REFERENCES mailbox_oauth_transactions(id);`)
  await db.run(sql`CREATE INDEX payload_locked_documents_rels_mailbox_oauth_transactions_id_idx ON payload_locked_documents_rels (mailbox_oauth_transactions_id);`)
}

export async function down({ db }: MigrateDownArgs) {
  await db.run(sql`DROP INDEX payload_locked_documents_rels_mailbox_oauth_transactions_id_idx;`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels DROP COLUMN mailbox_oauth_transactions_id;`)
  await db.run(sql`DROP TABLE mailbox_oauth_transactions;`)
}
