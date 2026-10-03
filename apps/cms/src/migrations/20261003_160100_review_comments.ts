import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

// Preview jobs were introduced by the preceding migration. This migration is
// limited to review comments so a fresh database can replay the entire chain.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`change_sets\` ADD \`review_comments\` text DEFAULT '[]';`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`change_sets\` DROP COLUMN \`review_comments\`;`)
}
