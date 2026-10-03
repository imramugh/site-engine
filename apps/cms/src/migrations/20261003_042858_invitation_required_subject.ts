import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`invitations\` ADD \`required_subject\` text;`)
  await db.run(sql`UPDATE \`invitations\` SET \`required_subject\` = \`provider_subject\`;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`invitations\` DROP COLUMN \`required_subject\`;`)
}
