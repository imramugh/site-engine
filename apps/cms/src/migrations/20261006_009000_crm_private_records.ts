import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`applications\` ADD \`notes\` text;`)
  await db.run(sql`CREATE TABLE \`external_replies\` (\`id\` text PRIMARY KEY NOT NULL, \`lead_id\` text NOT NULL, \`sent_at\` text NOT NULL, \`subject\` text NOT NULL, \`summary\` text NOT NULL, \`recorded_by_id\` text NOT NULL, \`idempotency_key\` text NOT NULL, \`created_at\` text NOT NULL, \`updated_at\` text NOT NULL);`)
  await db.run(sql`CREATE UNIQUE INDEX \`external_replies_idempotency_key_idx\` ON \`external_replies\` (\`idempotency_key\`);`)
  await db.run(sql`CREATE INDEX \`external_replies_lead_sent_at_idx\` ON \`external_replies\` (\`lead_id\`, \`sent_at\`);`)
  await db.run(sql`CREATE INDEX \`external_replies_recorded_by_id_idx\` ON \`external_replies\` (\`recorded_by_id\`);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`external_replies_id\` text(36) REFERENCES external_replies(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_external_replies_id_idx\` ON \`payload_locked_documents_rels\` (\`external_replies_id\`);`)
}
export async function down({ db }: MigrateDownArgs): Promise<void> {
  const [replies, notes] = await Promise.all([
    db.run(sql`SELECT COUNT(*) AS count FROM \`external_replies\`;`),
    db.run(sql`SELECT COUNT(*) AS count FROM \`applications\` WHERE \`notes\` IS NOT NULL AND \`notes\` != '';`),
  ])
  if (Number(replies.rows[0]?.count ?? 0) || Number(notes.rows[0]?.count ?? 0)) throw new Error('Cannot roll back CRM private records while external replies or application notes exist. Restore the expanded schema instead; no data was changed.')
  await db.run(sql`DROP INDEX \`payload_locked_documents_rels_external_replies_id_idx\`;`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` DROP COLUMN \`external_replies_id\`;`)
  await db.run(sql`DROP INDEX \`external_replies_recorded_by_id_idx\`;`)
  await db.run(sql`DROP INDEX \`external_replies_lead_sent_at_idx\`;`)
  await db.run(sql`DROP TABLE \`external_replies\`;`)
  await db.run(sql`ALTER TABLE \`applications\` DROP COLUMN \`notes\`;`)
}
