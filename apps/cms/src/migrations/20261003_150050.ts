import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`publish_outbox\` ADD \`sequence\` numeric NOT NULL;`)
  await db.run(sql`ALTER TABLE \`publish_outbox\` ADD \`lease_token\` text;`)
  await db.run(sql`ALTER TABLE \`publish_outbox\` ADD \`lease_expires_at\` text;`)
  await db.run(sql`ALTER TABLE \`publish_outbox\` ADD \`completed_at\` text;`)
  await db.run(sql`ALTER TABLE \`publish_outbox\` ADD \`completion_evidence\` text;`)
  await db.run(sql`ALTER TABLE \`publish_outbox\` ADD \`error_code\` text;`)
  await db.run(sql`CREATE UNIQUE INDEX \`publish_outbox_sequence_idx\` ON \`publish_outbox\` (\`sequence\`);`)
  await db.run(sql`ALTER TABLE \`published_releases\` ADD \`outbox_id\` text(36) NOT NULL REFERENCES publish_outbox(id);`)
  await db.run(sql`ALTER TABLE \`published_releases\` ADD \`sequence\` numeric NOT NULL;`)
  await db.run(sql`ALTER TABLE \`published_releases\` ADD \`artifact\` text NOT NULL;`)
  await db.run(sql`CREATE UNIQUE INDEX \`published_releases_outbox_idx\` ON \`published_releases\` (\`outbox_id\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`published_releases_sequence_idx\` ON \`published_releases\` (\`sequence\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_published_releases\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`snapshot_id\` text(36) NOT NULL,
  	\`activated_at\` text NOT NULL,
  	\`health_evidence\` text NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`snapshot_id\`) REFERENCES \`publish_snapshots\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`INSERT INTO \`__new_published_releases\`("id", "snapshot_id", "activated_at", "health_evidence", "updated_at", "created_at") SELECT "id", "snapshot_id", "activated_at", "health_evidence", "updated_at", "created_at" FROM \`published_releases\`;`)
  await db.run(sql`DROP TABLE \`published_releases\`;`)
  await db.run(sql`ALTER TABLE \`__new_published_releases\` RENAME TO \`published_releases\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE INDEX \`published_releases_snapshot_idx\` ON \`published_releases\` (\`snapshot_id\`);`)
  await db.run(sql`CREATE INDEX \`published_releases_updated_at_idx\` ON \`published_releases\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`published_releases_created_at_idx\` ON \`published_releases\` (\`created_at\`);`)
  await db.run(sql`DROP INDEX \`publish_outbox_sequence_idx\`;`)
  await db.run(sql`ALTER TABLE \`publish_outbox\` DROP COLUMN \`sequence\`;`)
  await db.run(sql`ALTER TABLE \`publish_outbox\` DROP COLUMN \`lease_token\`;`)
  await db.run(sql`ALTER TABLE \`publish_outbox\` DROP COLUMN \`lease_expires_at\`;`)
  await db.run(sql`ALTER TABLE \`publish_outbox\` DROP COLUMN \`completed_at\`;`)
  await db.run(sql`ALTER TABLE \`publish_outbox\` DROP COLUMN \`completion_evidence\`;`)
  await db.run(sql`ALTER TABLE \`publish_outbox\` DROP COLUMN \`error_code\`;`)
}
