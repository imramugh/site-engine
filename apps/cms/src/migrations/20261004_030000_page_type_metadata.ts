import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE pages ADD kicker text;`)
  await db.run(sql`ALTER TABLE pages ADD lede text;`)
  await db.run(sql`ALTER TABLE pages ADD published_at text;`)
  await db.run(sql`ALTER TABLE pages ADD last_reviewed text;`)
  await db.run(sql`ALTER TABLE pages ADD job_posting text;`)
  await db.run(sql`ALTER TABLE _pages_v ADD version_kicker text;`)
  await db.run(sql`ALTER TABLE _pages_v ADD version_lede text;`)
  await db.run(sql`ALTER TABLE _pages_v ADD version_published_at text;`)
  await db.run(sql`ALTER TABLE _pages_v ADD version_last_reviewed text;`)
  await db.run(sql`ALTER TABLE _pages_v ADD version_job_posting text;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`ALTER TABLE _pages_v DROP COLUMN version_job_posting;`)
  await db.run(sql`ALTER TABLE _pages_v DROP COLUMN version_last_reviewed;`)
  await db.run(sql`ALTER TABLE _pages_v DROP COLUMN version_published_at;`)
  await db.run(sql`ALTER TABLE _pages_v DROP COLUMN version_lede;`)
  await db.run(sql`ALTER TABLE _pages_v DROP COLUMN version_kicker;`)
  await db.run(sql`ALTER TABLE pages DROP COLUMN job_posting;`)
  await db.run(sql`ALTER TABLE pages DROP COLUMN last_reviewed;`)
  await db.run(sql`ALTER TABLE pages DROP COLUMN published_at;`)
  await db.run(sql`ALTER TABLE pages DROP COLUMN lede;`)
  await db.run(sql`ALTER TABLE pages DROP COLUMN kicker;`)
}
