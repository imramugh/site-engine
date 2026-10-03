import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`users\` ADD \`emergency_totp_secret\` text;`)
  await db.run(sql`ALTER TABLE \`users\` ADD \`emergency_recovery_hashes\` text;`)
  await db.run(sql`ALTER TABLE \`users\` ADD \`emergency_last_counter\` numeric;`)
  await db.run(sql`ALTER TABLE \`users\` ADD \`emergency_failed_at\` text;`)
  await db.run(sql`ALTER TABLE \`users\` ADD \`emergency_failed_count\` numeric DEFAULT 0;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`users\` DROP COLUMN \`emergency_totp_secret\`;`)
  await db.run(sql`ALTER TABLE \`users\` DROP COLUMN \`emergency_recovery_hashes\`;`)
  await db.run(sql`ALTER TABLE \`users\` DROP COLUMN \`emergency_last_counter\`;`)
  await db.run(sql`ALTER TABLE \`users\` DROP COLUMN \`emergency_failed_at\`;`)
  await db.run(sql`ALTER TABLE \`users\` DROP COLUMN \`emergency_failed_count\`;`)
}
