import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

/** Nullable-compatible expansion: existing digest-only drafts remain valid while
 * new drafts retain server-derived immutable attachment descriptors. */
export async function up({ db }: MigrateUpArgs): Promise<void> { await db.run(sql`ALTER TABLE mail_drafts ADD attachments text DEFAULT '[]';`) }
export async function down({ db }: MigrateDownArgs): Promise<void> {
  const used = await db.run(sql`SELECT COUNT(*) AS count FROM mail_drafts WHERE attachments IS NOT NULL AND attachments != '[]';`)
  if (Number(used.rows[0]?.count ?? 0)) throw new Error('Cannot roll back mail attachment descriptors while drafts retain attachments.')
  await db.run(sql`ALTER TABLE mail_drafts DROP COLUMN attachments;`)
}
