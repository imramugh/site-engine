import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`users\` ADD \`email\` text NOT NULL;`)
  await db.run(sql`CREATE UNIQUE INDEX \`users_email_idx\` ON \`users\` (\`email\`);`)
  await db.run(sql`ALTER TABLE \`sections\` ADD \`summary\` text;`)
  await db.run(sql`ALTER TABLE \`_sections_v\` ADD \`version_summary\` text;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`users_email_idx\`;`)
  await db.run(sql`ALTER TABLE \`users\` DROP COLUMN \`email\`;`)
  await db.run(sql`ALTER TABLE \`sections\` DROP COLUMN \`summary\`;`)
  await db.run(sql`ALTER TABLE \`_sections_v\` DROP COLUMN \`version_summary\`;`)
}
