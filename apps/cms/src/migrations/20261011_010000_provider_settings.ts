import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`integration_configurations\` ADD \`provider_settings\` text DEFAULT '{}' NOT NULL;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`integration_configurations\` DROP COLUMN \`provider_settings\`;`)
}
