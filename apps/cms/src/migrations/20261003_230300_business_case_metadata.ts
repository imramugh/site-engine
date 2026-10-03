import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE pages ADD business_case text;`)
  await db.run(sql`ALTER TABLE _pages_v ADD version_business_case text;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`ALTER TABLE _pages_v DROP COLUMN version_business_case;`)
  await db.run(sql`ALTER TABLE pages DROP COLUMN business_case;`)
}
