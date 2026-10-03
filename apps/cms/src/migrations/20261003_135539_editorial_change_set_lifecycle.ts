import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_change_sets\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  \`actor_id\` text(36),
  	\`state\` text DEFAULT 'open',
  	\`revision\` numeric DEFAULT 0,
  	\`changes\` text DEFAULT '[]',
  	\`quality\` text,
  	\`submitted_at\` text,
  	\`reviewed_at\` text,
  	\`stale_at\` text,
  	\`summary\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`actor_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  // Legacy records predate actor and field-diff capture. Retain them as open
  // records and map historical review state without inventing an actor.
  await db.run(sql`INSERT INTO \`__new_change_sets\`("id", "name", "actor_id", "state", "revision", "changes", "quality", "submitted_at", "reviewed_at", "stale_at", "summary", "updated_at", "created_at") SELECT "id", "name", NULL, CASE "state" WHEN 'draft' THEN 'open' WHEN 'inReview' THEN 'submitted' ELSE "state" END, "revision", '[]', NULL, NULL, NULL, NULL, "summary", "updated_at", "created_at" FROM \`change_sets\`;`)
  await db.run(sql`DROP TABLE \`change_sets\`;`)
  await db.run(sql`ALTER TABLE \`__new_change_sets\` RENAME TO \`change_sets\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE INDEX \`change_sets_actor_idx\` ON \`change_sets\` (\`actor_id\`);`)
  await db.run(sql`CREATE INDEX \`change_sets_updated_at_idx\` ON \`change_sets\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`change_sets_created_at_idx\` ON \`change_sets\` (\`created_at\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_change_sets\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  	\`state\` text DEFAULT 'draft',
  	\`revision\` numeric DEFAULT 0,
  	\`summary\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`INSERT INTO \`__new_change_sets\`("id", "name", "state", "revision", "summary", "updated_at", "created_at") SELECT "id", "name", "state", "revision", "summary", "updated_at", "created_at" FROM \`change_sets\`;`)
  await db.run(sql`DROP TABLE \`change_sets\`;`)
  await db.run(sql`ALTER TABLE \`__new_change_sets\` RENAME TO \`change_sets\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE INDEX \`change_sets_updated_at_idx\` ON \`change_sets\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`change_sets_created_at_idx\` ON \`change_sets\` (\`created_at\`);`)
}
