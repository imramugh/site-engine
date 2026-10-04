import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`change_sets\` ADD \`creation_request_key\` text;`)
  await db.run(sql`ALTER TABLE \`change_sets\` ADD \`creation_request_hash\` text;`)
  await db.run(sql`CREATE UNIQUE INDEX \`change_sets_creation_request_key_idx\` ON \`change_sets\` (\`creation_request_key\`);`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`change_sets_creation_request_key_idx\`;`)
  await db.run(sql`ALTER TABLE \`change_sets\` DROP COLUMN \`creation_request_key\`;`)
  await db.run(sql`ALTER TABLE \`change_sets\` DROP COLUMN \`creation_request_hash\`;`)
}
