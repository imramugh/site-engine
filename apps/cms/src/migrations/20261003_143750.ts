import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`publish_snapshots\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`content_hash\` text NOT NULL,
  	\`change_set_id\` text(36) NOT NULL,
  	\`review_revision\` numeric NOT NULL,
  	\`change_hash\` text NOT NULL,
  	\`manifest\` text NOT NULL,
  	\`theme_version\` text NOT NULL,
  	\`engine_version\` text NOT NULL,
  	\`contract_version\` text NOT NULL,
  	\`approved_by_id\` text(36) NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`change_set_id\`) REFERENCES \`change_sets\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`approved_by_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`publish_snapshots_content_hash_idx\` ON \`publish_snapshots\` (\`content_hash\`);`)
  await db.run(sql`CREATE INDEX \`publish_snapshots_change_set_idx\` ON \`publish_snapshots\` (\`change_set_id\`);`)
  await db.run(sql`CREATE INDEX \`publish_snapshots_approved_by_idx\` ON \`publish_snapshots\` (\`approved_by_id\`);`)
  await db.run(sql`CREATE INDEX \`publish_snapshots_updated_at_idx\` ON \`publish_snapshots\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`publish_snapshots_created_at_idx\` ON \`publish_snapshots\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`publish_outbox\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`idempotency_key\` text NOT NULL,
  	\`snapshot_id\` text(36) NOT NULL,
  	\`change_set_id\` text(36) NOT NULL,
  	\`status\` text DEFAULT 'pending' NOT NULL,
  	\`attempts\` numeric DEFAULT 0 NOT NULL,
  	\`next_attempt_at\` text,
  	\`claimed_at\` text,
  	\`correlation_i_d\` text NOT NULL,
  	\`last_error\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`snapshot_id\`) REFERENCES \`publish_snapshots\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`change_set_id\`) REFERENCES \`change_sets\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`publish_outbox_idempotency_key_idx\` ON \`publish_outbox\` (\`idempotency_key\`);`)
  await db.run(sql`CREATE INDEX \`publish_outbox_snapshot_idx\` ON \`publish_outbox\` (\`snapshot_id\`);`)
  await db.run(sql`CREATE INDEX \`publish_outbox_change_set_idx\` ON \`publish_outbox\` (\`change_set_id\`);`)
  await db.run(sql`CREATE INDEX \`publish_outbox_updated_at_idx\` ON \`publish_outbox\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`publish_outbox_created_at_idx\` ON \`publish_outbox\` (\`created_at\`);`)
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_change_sets\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  	\`actor_id\` text(36),
  	\`state\` text DEFAULT 'open',
  	\`revision\` numeric DEFAULT 0,
  	\`changes\` text DEFAULT '[]',
  	\`quality\` text,
  	\`preview\` text,
  	\`submitted_at\` text,
  	\`reviewed_at\` text,
  	\`stale_at\` text,
  	\`summary\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`actor_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`INSERT INTO \`__new_change_sets\`("id", "name", "actor_id", "state", "revision", "changes", "quality", "preview", "submitted_at", "reviewed_at", "stale_at", "summary", "updated_at", "created_at") SELECT "id", "name", "actor_id", "state", "revision", "changes", "quality", NULL, "submitted_at", "reviewed_at", "stale_at", "summary", "updated_at", "created_at" FROM \`change_sets\`;`)
  await db.run(sql`DROP TABLE \`change_sets\`;`)
  await db.run(sql`ALTER TABLE \`__new_change_sets\` RENAME TO \`change_sets\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE INDEX \`change_sets_actor_idx\` ON \`change_sets\` (\`actor_id\`);`)
  await db.run(sql`CREATE INDEX \`change_sets_updated_at_idx\` ON \`change_sets\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`change_sets_created_at_idx\` ON \`change_sets\` (\`created_at\`);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`publish_snapshots_id\` text(36) REFERENCES publish_snapshots(id);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`publish_outbox_id\` text(36) REFERENCES publish_outbox(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_publish_snapshots_id_idx\` ON \`payload_locked_documents_rels\` (\`publish_snapshots_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_publish_outbox_id_idx\` ON \`payload_locked_documents_rels\` (\`publish_outbox_id\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`publish_snapshots\`;`)
  await db.run(sql`DROP TABLE \`publish_outbox\`;`)
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_payload_locked_documents_rels\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer,
  	\`parent_id\` text(36) NOT NULL,
  	\`path\` text NOT NULL,
  	\`users_id\` text(36),
  	\`invitations_id\` text(36),
  	\`auth_sessions_id\` text(36),
  	\`auth_transactions_id\` text(36),
  	\`audit_events_id\` text(36),
  	\`pages_id\` text(36),
  	\`sections_id\` text(36),
  	\`assets_id\` text(36),
  	\`redirects_id\` text(36),
  	\`inquiries_id\` text(36),
  	\`applications_id\` text(36),
  	\`change_sets_id\` text(36),
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`payload_locked_documents\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`users_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`invitations_id\`) REFERENCES \`invitations\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`auth_sessions_id\`) REFERENCES \`auth_sessions\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`auth_transactions_id\`) REFERENCES \`auth_transactions\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`audit_events_id\`) REFERENCES \`audit_events\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`pages_id\`) REFERENCES \`pages\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`sections_id\`) REFERENCES \`sections\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`assets_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`redirects_id\`) REFERENCES \`redirects\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`inquiries_id\`) REFERENCES \`inquiries\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`applications_id\`) REFERENCES \`applications\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`change_sets_id\`) REFERENCES \`change_sets\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`INSERT INTO \`__new_payload_locked_documents_rels\`("id", "order", "parent_id", "path", "users_id", "invitations_id", "auth_sessions_id", "auth_transactions_id", "audit_events_id", "pages_id", "sections_id", "assets_id", "redirects_id", "inquiries_id", "applications_id", "change_sets_id") SELECT "id", "order", "parent_id", "path", "users_id", "invitations_id", "auth_sessions_id", "auth_transactions_id", "audit_events_id", "pages_id", "sections_id", "assets_id", "redirects_id", "inquiries_id", "applications_id", "change_sets_id" FROM \`payload_locked_documents_rels\`;`)
  await db.run(sql`DROP TABLE \`payload_locked_documents_rels\`;`)
  await db.run(sql`ALTER TABLE \`__new_payload_locked_documents_rels\` RENAME TO \`payload_locked_documents_rels\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_order_idx\` ON \`payload_locked_documents_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_parent_idx\` ON \`payload_locked_documents_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_path_idx\` ON \`payload_locked_documents_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_users_id_idx\` ON \`payload_locked_documents_rels\` (\`users_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_invitations_id_idx\` ON \`payload_locked_documents_rels\` (\`invitations_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_auth_sessions_id_idx\` ON \`payload_locked_documents_rels\` (\`auth_sessions_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_auth_transactions_id_idx\` ON \`payload_locked_documents_rels\` (\`auth_transactions_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_audit_events_id_idx\` ON \`payload_locked_documents_rels\` (\`audit_events_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_pages_id_idx\` ON \`payload_locked_documents_rels\` (\`pages_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_sections_id_idx\` ON \`payload_locked_documents_rels\` (\`sections_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_assets_id_idx\` ON \`payload_locked_documents_rels\` (\`assets_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_redirects_id_idx\` ON \`payload_locked_documents_rels\` (\`redirects_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_inquiries_id_idx\` ON \`payload_locked_documents_rels\` (\`inquiries_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_applications_id_idx\` ON \`payload_locked_documents_rels\` (\`applications_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_change_sets_id_idx\` ON \`payload_locked_documents_rels\` (\`change_sets_id\`);`)
  await db.run(sql`CREATE TABLE \`__new_change_sets\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  	\`actor_id\` text(36) NOT NULL,
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
  await db.run(sql`INSERT INTO \`__new_change_sets\`("id", "name", "actor_id", "state", "revision", "changes", "quality", "submitted_at", "reviewed_at", "stale_at", "summary", "updated_at", "created_at") SELECT "id", "name", "actor_id", "state", "revision", "changes", "quality", "submitted_at", "reviewed_at", "stale_at", "summary", "updated_at", "created_at" FROM \`change_sets\`;`)
  await db.run(sql`DROP TABLE \`change_sets\`;`)
  await db.run(sql`ALTER TABLE \`__new_change_sets\` RENAME TO \`change_sets\`;`)
  await db.run(sql`CREATE INDEX \`change_sets_actor_idx\` ON \`change_sets\` (\`actor_id\`);`)
  await db.run(sql`CREATE INDEX \`change_sets_updated_at_idx\` ON \`change_sets\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`change_sets_created_at_idx\` ON \`change_sets\` (\`created_at\`);`)
}
