import { sql, type MigrateDownArgs, type MigrateUpArgs } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs) {
  await db.run(sql`ALTER TABLE inquiries ADD next_action_due_at text;`)
  await db.run(sql`CREATE INDEX inquiries_next_action_due_at_idx ON inquiries (next_action_due_at);`)
}
export async function down({ db }: MigrateDownArgs) {
  await db.run(sql`DROP INDEX inquiries_next_action_due_at_idx;`)
  await db.run(sql`ALTER TABLE inquiries DROP COLUMN next_action_due_at;`)
}
