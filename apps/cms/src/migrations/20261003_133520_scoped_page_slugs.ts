import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`DROP INDEX IF EXISTS \`pages_slug_idx\`;`)
  await db.run(sql`DROP INDEX IF EXISTS \`_pages_v_version_version_slug_idx\`;`)
  await db.run(sql`CREATE UNIQUE INDEX \`pages_section_parent_slug_idx\` ON \`pages\` (\`section_id_id\`, IFNULL(\`parent_id_id\`, ''), \`slug\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX IF EXISTS \`pages_section_parent_slug_idx\`;`)
  await db.run(sql`CREATE UNIQUE INDEX \`pages_slug_idx\` ON \`pages\` (\`slug\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_slug_idx\` ON \`_pages_v\` (\`version_slug\`);`)
}
