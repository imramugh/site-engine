import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE sections ADD landing_page_id_id text(36) REFERENCES pages(id);`)
  await db.run(sql`CREATE INDEX sections_landing_page_id_idx ON sections (landing_page_id_id);`)
  await db.run(sql`ALTER TABLE _sections_v ADD version_landing_page_id_id text(36) REFERENCES pages(id);`)
  await db.run(sql`CREATE INDEX _sections_v_version_landing_page_id_idx ON _sections_v (version_landing_page_id_id);`)
}
export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX _sections_v_version_landing_page_id_idx;`)
  await db.run(sql`ALTER TABLE _sections_v DROP COLUMN version_landing_page_id_id;`)
  await db.run(sql`DROP INDEX sections_landing_page_id_idx;`)
  await db.run(sql`ALTER TABLE sections DROP COLUMN landing_page_id_id;`)
}
