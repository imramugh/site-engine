import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

/** Keep approved future releases outside the publish queue until a later dispatcher enqueues them. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`scheduled_publications\` (
    \`id\` text(36) PRIMARY KEY NOT NULL,
    \`idempotency_key\` text NOT NULL,
    \`snapshot_id\` text(36) NOT NULL,
    \`change_set_id\` text(36) NOT NULL,
    \`scheduled_for\` text NOT NULL,
    \`state\` text DEFAULT 'scheduled' NOT NULL,
    \`proof\` text NOT NULL,
    \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    FOREIGN KEY (\`snapshot_id\`) REFERENCES \`publish_snapshots\`(\`id\`) ON UPDATE no action ON DELETE set null,
    FOREIGN KEY (\`change_set_id\`) REFERENCES \`change_sets\`(\`id\`) ON UPDATE no action ON DELETE set null
  );`)
  await db.run(sql`CREATE UNIQUE INDEX \`scheduled_publications_idempotency_key_idx\` ON \`scheduled_publications\` (\`idempotency_key\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`scheduled_publications_snapshot_idx\` ON \`scheduled_publications\` (\`snapshot_id\`);`)
  await db.run(sql`CREATE INDEX \`scheduled_publications_change_set_idx\` ON \`scheduled_publications\` (\`change_set_id\`);`)
  await db.run(sql`CREATE INDEX \`scheduled_publications_updated_at_idx\` ON \`scheduled_publications\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`scheduled_publications_created_at_idx\` ON \`scheduled_publications\` (\`created_at\`);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`scheduled_publications_id\` text(36) REFERENCES scheduled_publications(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_scheduled_publications_id_idx\` ON \`payload_locked_documents_rels\` (\`scheduled_publications_id\`);`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`payload_locked_documents_rels_scheduled_publications_id_idx\`;`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` DROP COLUMN \`scheduled_publications_id\`;`)
  await db.run(sql`DROP TABLE \`scheduled_publications\`;`)
}
