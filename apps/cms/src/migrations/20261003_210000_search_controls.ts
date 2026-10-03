import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

/** Persist reviewed public-search controls for current records and page drafts. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`pages\` ADD \`noindex\` integer DEFAULT false NOT NULL;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_noindex\` integer DEFAULT false NOT NULL;`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`search_enabled\` integer DEFAULT false NOT NULL;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`site_settings\` DROP COLUMN \`search_enabled\`;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` DROP COLUMN \`version_noindex\`;`)
  await db.run(sql`ALTER TABLE \`pages\` DROP COLUMN \`noindex\`;`)
}
