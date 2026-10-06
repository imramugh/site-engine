import { sql, type MigrateDownArgs, type MigrateUpArgs } from '@payloadcms/db-sqlite'
export async function up({ db }: MigrateUpArgs) {
  await db.run(sql`ALTER TABLE mailbox_configurations ADD inbound_next_attempt_at text;`)
  await db.run(sql`ALTER TABLE mailbox_configurations ADD inbound_failure_count integer DEFAULT 0 NOT NULL;`)
  await db.run(sql`ALTER TABLE mailbox_configurations ADD inbound_last_error text;`)
  await db.run(sql`ALTER TABLE mailbox_configurations ADD inbound_last_synced_at text;`)
  await db.run(sql`CREATE INDEX mailbox_configurations_inbound_next_attempt_idx ON mailbox_configurations (inbound_next_attempt_at);`)
}
export async function down({ db }: MigrateDownArgs) {
  await db.run(sql`DROP INDEX mailbox_configurations_inbound_next_attempt_idx;`)
  await db.run(sql`ALTER TABLE mailbox_configurations DROP COLUMN inbound_last_synced_at;`)
  await db.run(sql`ALTER TABLE mailbox_configurations DROP COLUMN inbound_last_error;`)
  await db.run(sql`ALTER TABLE mailbox_configurations DROP COLUMN inbound_failure_count;`)
  await db.run(sql`ALTER TABLE mailbox_configurations DROP COLUMN inbound_next_attempt_at;`)
}
