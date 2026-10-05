import { type MigrateDownArgs, type MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`inquiries\` ADD \`spam\` numeric DEFAULT 0;`)
  await db.run(sql`ALTER TABLE \`inquiries\` ADD \`spam_marked_at\` text;`)
  await db.run(sql`ALTER TABLE \`inquiries\` ADD \`spam_previous_stage\` text;`)
  await db.run(sql`UPDATE \`inquiries\` SET \`spam\` = 0 WHERE \`spam\` IS NULL;`)
  await db.run(sql`CREATE INDEX \`inquiries_spam_idx\` ON \`inquiries\` (\`spam\`);`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX IF EXISTS \`inquiries_spam_idx\`;`)
  await db.run(sql`ALTER TABLE \`inquiries\` DROP COLUMN \`spam_previous_stage\`;`)
  await db.run(sql`ALTER TABLE \`inquiries\` DROP COLUMN \`spam_marked_at\`;`)
  await db.run(sql`ALTER TABLE \`inquiries\` DROP COLUMN \`spam\`;`)
}
