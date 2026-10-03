import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`notification_outbox\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`inquiry_id\` text(36) NOT NULL,
  	\`kind\` text NOT NULL,
  	\`idempotency_key\` text NOT NULL,
  	\`state\` text DEFAULT 'queued' NOT NULL,
  	\`payload\` text NOT NULL,
  	\`available_at\` text NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`inquiry_id\`) REFERENCES \`inquiries\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`notification_outbox_inquiry_idx\` ON \`notification_outbox\` (\`inquiry_id\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`notification_outbox_idempotency_key_idx\` ON \`notification_outbox\` (\`idempotency_key\`);`)
  await db.run(sql`CREATE INDEX \`notification_outbox_updated_at_idx\` ON \`notification_outbox\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`notification_outbox_created_at_idx\` ON \`notification_outbox\` (\`created_at\`);`)
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_inquiries\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`email\` text NOT NULL,
  	\`name\` text,
  	\`telephone\` text,
  	\`company\` text,
  	\`message\` text NOT NULL,
  	\`topic\` text NOT NULL,
  	\`source_page\` text NOT NULL,
	\`consented_at\` text NOT NULL,
	\`consent_basis\` text NOT NULL,
  	\`idempotency_key\` text NOT NULL,
  	\`stage\` text DEFAULT 'new' NOT NULL,
  	\`urgent\` integer DEFAULT false,
  	\`notes\` text,
  	\`assignee_id\` text(36),
  	\`next_action\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`assignee_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  // This migration expands a live table that predates the intake metadata.
  // Backfilled values preserve the recorded legacy timestamp but mark consent
  // provenance as unknown rather than claiming historic visitor confirmation.
  await db.run(sql`INSERT INTO \`__new_inquiries\`("id", "email", "name", "telephone", "company", "message", "topic", "source_page", "consented_at", "consent_basis", "idempotency_key", "stage", "urgent", "notes", "assignee_id", "next_action", "updated_at", "created_at") SELECT "id", "email", NULL, NULL, NULL, "message", 'general', '/legacy-import', "created_at", 'unknown', 'legacy:' || "id", CASE "status" WHEN 'contacted' THEN 'contacted' WHEN 'closed' THEN 'lost' ELSE 'new' END, false, NULL, NULL, NULL, "updated_at", "created_at" FROM \`inquiries\`;`)
  await db.run(sql`DROP TABLE \`inquiries\`;`)
  await db.run(sql`ALTER TABLE \`__new_inquiries\` RENAME TO \`inquiries\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE UNIQUE INDEX \`inquiries_idempotency_key_idx\` ON \`inquiries\` (\`idempotency_key\`);`)
  await db.run(sql`CREATE INDEX \`inquiries_assignee_idx\` ON \`inquiries\` (\`assignee_id\`);`)
  await db.run(sql`CREATE INDEX \`inquiries_updated_at_idx\` ON \`inquiries\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`inquiries_created_at_idx\` ON \`inquiries\` (\`created_at\`);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`notification_outbox_id\` text(36) REFERENCES notification_outbox(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_notification_outbox_id_idx\` ON \`payload_locked_documents_rels\` (\`notification_outbox_id\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`notification_outbox\`;`)
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_inquiries\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`email\` text NOT NULL,
  	\`message\` text NOT NULL,
  	\`status\` text DEFAULT 'new',
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`INSERT INTO \`__new_inquiries\`("id", "email", "message", "status", "updated_at", "created_at") SELECT "id", "email", "message", CASE "stage" WHEN 'contacted' THEN 'contacted' WHEN 'won' THEN 'closed' WHEN 'lost' THEN 'closed' ELSE 'new' END, "updated_at", "created_at" FROM \`inquiries\`;`)
  await db.run(sql`DROP TABLE \`inquiries\`;`)
  await db.run(sql`ALTER TABLE \`__new_inquiries\` RENAME TO \`inquiries\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE INDEX \`inquiries_updated_at_idx\` ON \`inquiries\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`inquiries_created_at_idx\` ON \`inquiries\` (\`created_at\`);`)
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
}
