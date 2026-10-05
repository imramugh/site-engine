import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`applications\` ADD \`telephone\` text;`)
  await db.run(sql`ALTER TABLE \`applications\` ADD \`linked_in\` text;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`applications\` DROP COLUMN \`linked_in\`;`)
  await db.run(sql`ALTER TABLE \`applications\` DROP COLUMN \`telephone\`;`)
}
