import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`integration_configurations\` ADD \`monthly_cap_micro_usd\` numeric;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` ADD \`monthly_usage_micro_usd\` numeric DEFAULT 0 NOT NULL;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` ADD \`input_micro_usd_per_million_tokens\` numeric;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` ADD \`output_micro_usd_per_million_tokens\` numeric;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` ADD \`pricing_source\` text;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` ADD \`pricing_as_of\` text;`)
}
export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`integration_configurations\` DROP COLUMN \`pricing_as_of\`;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` DROP COLUMN \`pricing_source\`;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` DROP COLUMN \`output_micro_usd_per_million_tokens\`;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` DROP COLUMN \`input_micro_usd_per_million_tokens\`;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` DROP COLUMN \`monthly_usage_micro_usd\`;`)
  await db.run(sql`ALTER TABLE \`integration_configurations\` DROP COLUMN \`monthly_cap_micro_usd\`;`)
}
