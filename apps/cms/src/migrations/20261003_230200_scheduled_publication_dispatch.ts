import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

/** Records a one-time outbox handoff and a concise actionable dispatch outcome. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`scheduled_publications\` ADD \`outbox_id\` text(36) REFERENCES publish_outbox(id);`)
  await db.run(sql`ALTER TABLE \`scheduled_publications\` ADD \`enqueued_at\` text;`)
  await db.run(sql`ALTER TABLE \`scheduled_publications\` ADD \`dispatch_reason\` text;`)
  await db.run(sql`CREATE UNIQUE INDEX \`scheduled_publications_outbox_idx\` ON \`scheduled_publications\` (\`outbox_id\`);`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`scheduled_publications_outbox_idx\`;`)
  await db.run(sql`ALTER TABLE \`scheduled_publications\` DROP COLUMN \`dispatch_reason\`;`)
  await db.run(sql`ALTER TABLE \`scheduled_publications\` DROP COLUMN \`enqueued_at\`;`)
  await db.run(sql`ALTER TABLE \`scheduled_publications\` DROP COLUMN \`outbox_id\`;`)
}
