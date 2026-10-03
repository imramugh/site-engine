import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`redirects\` ADD \`hit_count\` numeric DEFAULT 0;`)
  await db.run(sql`ALTER TABLE \`redirects\` ADD \`last_hit_at\` text;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`redirects\` DROP COLUMN \`hit_count\`;`)
  await db.run(sql`ALTER TABLE \`redirects\` DROP COLUMN \`last_hit_at\`;`)
}
