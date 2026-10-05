import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`redirects\` ADD \`created_by_id\` text(36) REFERENCES users(id);`)
  await db.run(sql`ALTER TABLE \`redirects\` ADD \`created_by_label\` text;`)
  await db.run(sql`CREATE INDEX \`redirects_created_by_idx\` ON \`redirects\` (\`created_by_id\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_redirects\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`from\` text NOT NULL,
  	\`to\` text NOT NULL,
  	\`status\` numeric DEFAULT 301,
  	\`hit_count\` numeric DEFAULT 0,
  	\`last_hit_at\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`INSERT INTO \`__new_redirects\`("id", "from", "to", "status", "hit_count", "last_hit_at", "updated_at", "created_at") SELECT "id", "from", "to", "status", "hit_count", "last_hit_at", "updated_at", "created_at" FROM \`redirects\`;`)
  await db.run(sql`DROP TABLE \`redirects\`;`)
  await db.run(sql`ALTER TABLE \`__new_redirects\` RENAME TO \`redirects\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE UNIQUE INDEX \`redirects_from_idx\` ON \`redirects\` (\`from\`);`)
  await db.run(sql`CREATE INDEX \`redirects_updated_at_idx\` ON \`redirects\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`redirects_created_at_idx\` ON \`redirects\` (\`created_at\`);`)
}
