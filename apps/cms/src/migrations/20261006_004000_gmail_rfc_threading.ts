import { sql, type MigrateDownArgs, type MigrateUpArgs } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs) {
  await db.run(sql`ALTER TABLE mail_thread_messages ADD rfc_message_i_d text;`)
  await db.run(sql`ALTER TABLE mail_thread_messages ADD rfc_references text;`)
}

export async function down({ db }: MigrateDownArgs) {
  await db.run(sql`ALTER TABLE mail_thread_messages DROP COLUMN rfc_references;`)
  await db.run(sql`ALTER TABLE mail_thread_messages DROP COLUMN rfc_message_i_d;`)
}
