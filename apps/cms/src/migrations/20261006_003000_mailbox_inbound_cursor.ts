import { sql, type MigrateDownArgs, type MigrateUpArgs } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs) {
  await db.run(sql`ALTER TABLE mailbox_configurations ADD inbound_cursor text;`)
  await db.run(sql`ALTER TABLE mailbox_configurations ADD inbound_cursor_revision text;`)
  await db.run(sql`CREATE INDEX mailbox_configurations_inbound_cursor_revision_idx ON mailbox_configurations (inbound_cursor_revision);`)
}

export async function down({ db }: MigrateDownArgs) {
  await db.run(sql`DROP INDEX mailbox_configurations_inbound_cursor_revision_idx;`)
  await db.run(sql`ALTER TABLE mailbox_configurations DROP COLUMN inbound_cursor_revision;`)
  await db.run(sql`ALTER TABLE mailbox_configurations DROP COLUMN inbound_cursor;`)
}
