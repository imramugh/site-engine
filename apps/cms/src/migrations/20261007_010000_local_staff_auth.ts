import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

/** Expand only: legacy OIDC invitation metadata remains for audit history. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`invitations\` ADD \`pending_totp_secret\` text;`)
  await db.run(sql`ALTER TABLE \`invitations\` ADD \`enrollment_failed_at\` text;`)
  await db.run(sql`ALTER TABLE \`invitations\` ADD \`enrollment_failed_count\` numeric DEFAULT 0;`)
  await db.run(sql`UPDATE \`invitations\` SET \`expires_at\` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE \`provider\` IN ('google', 'microsoft') AND \`accepted_at\` IS NULL;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`invitations\` DROP COLUMN \`pending_totp_secret\`;`)
  await db.run(sql`ALTER TABLE \`invitations\` DROP COLUMN \`enrollment_failed_at\`;`)
  await db.run(sql`ALTER TABLE \`invitations\` DROP COLUMN \`enrollment_failed_count\`;`)
}
