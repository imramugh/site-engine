import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`publish_snapshots_content_hash_idx\`;`)
  await db.run(sql`ALTER TABLE \`publish_snapshots\` ADD \`baseline_snapshot_id\` text(36) REFERENCES publish_snapshots(id);`)
  await db.run(sql`ALTER TABLE \`publish_snapshots\` ADD \`baseline_sequence\` numeric NOT NULL DEFAULT 0;`)
  await db.run(sql`CREATE INDEX \`publish_snapshots_baseline_snapshot_idx\` ON \`publish_snapshots\` (\`baseline_snapshot_id\`);`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`publish_snapshots_baseline_snapshot_idx\`;`)
  await db.run(sql`ALTER TABLE \`publish_snapshots\` DROP COLUMN \`baseline_snapshot_id\`;`)
  await db.run(sql`ALTER TABLE \`publish_snapshots\` DROP COLUMN \`baseline_sequence\`;`)
  await db.run(sql`CREATE UNIQUE INDEX \`publish_snapshots_content_hash_idx\` ON \`publish_snapshots\` (\`content_hash\`);`)
}
