import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`integration_configurations\` ADD \`monthly_usage\` numeric DEFAULT 0 NOT NULL;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` ADD \`usage_month\` text;`)
}
export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`integration_configurations\` DROP COLUMN \`usage_month\`;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` DROP COLUMN \`monthly_usage\`;`)
}
