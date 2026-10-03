import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`preview_render_jobs\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`change_set_id\` text(36) NOT NULL,
  	\`review_revision\` numeric NOT NULL,
  	\`change_hash\` text NOT NULL,
  	\`included_change_keys\` text NOT NULL,
  	\`baseline_snapshot_id\` text(36),
  	\`baseline_sequence\` numeric DEFAULT 0 NOT NULL,
  	\`live_snapshot_id\` text(36),
  	\`live_sequence\` numeric DEFAULT 0 NOT NULL,
  	\`live_manifest\` text NOT NULL,
  	\`proposed_manifest\` text NOT NULL,
  	\`live_manifest_hash\` text NOT NULL,
  	\`proposed_manifest_hash\` text NOT NULL,
  	\`version_pins\` text NOT NULL,
  	\`status\` text DEFAULT 'pending' NOT NULL,
  	\`attempts\` numeric DEFAULT 0 NOT NULL,
  	\`next_attempt_at\` text,
  	\`lease_token\` text,
  	\`lease_expires_at\` text,
  	\`completed_at\` text,
  	\`artifact_digest\` text,
  	\`error_code\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`change_set_id\`) REFERENCES \`change_sets\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`baseline_snapshot_id\`) REFERENCES \`publish_snapshots\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`live_snapshot_id\`) REFERENCES \`publish_snapshots\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`preview_render_jobs_change_set_idx\` ON \`preview_render_jobs\` (\`change_set_id\`);`)
  await db.run(sql`CREATE INDEX \`preview_render_jobs_baseline_snapshot_idx\` ON \`preview_render_jobs\` (\`baseline_snapshot_id\`);`)
  await db.run(sql`CREATE INDEX \`preview_render_jobs_live_snapshot_idx\` ON \`preview_render_jobs\` (\`live_snapshot_id\`);`)
  await db.run(sql`CREATE INDEX \`preview_render_jobs_updated_at_idx\` ON \`preview_render_jobs\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`preview_render_jobs_created_at_idx\` ON \`preview_render_jobs\` (\`created_at\`);`)
  await db.run(sql`ALTER TABLE \`change_sets\` ADD \`review_comments\` text DEFAULT '[]';`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`preview_render_jobs_id\` text(36) REFERENCES preview_render_jobs(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_preview_render_jobs_id_idx\` ON \`payload_locked_documents_rels\` (\`preview_render_jobs_id\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`preview_render_jobs\`;`)
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
  	\`publish_snapshots_id\` text(36),
  	\`publish_outbox_id\` text(36),
  	\`published_releases_id\` text(36),
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
  	FOREIGN KEY (\`change_sets_id\`) REFERENCES \`change_sets\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`publish_snapshots_id\`) REFERENCES \`publish_snapshots\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`publish_outbox_id\`) REFERENCES \`publish_outbox\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`published_releases_id\`) REFERENCES \`published_releases\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`INSERT INTO \`__new_payload_locked_documents_rels\`("id", "order", "parent_id", "path", "users_id", "invitations_id", "auth_sessions_id", "auth_transactions_id", "audit_events_id", "pages_id", "sections_id", "assets_id", "redirects_id", "inquiries_id", "applications_id", "change_sets_id", "publish_snapshots_id", "publish_outbox_id", "published_releases_id") SELECT "id", "order", "parent_id", "path", "users_id", "invitations_id", "auth_sessions_id", "auth_transactions_id", "audit_events_id", "pages_id", "sections_id", "assets_id", "redirects_id", "inquiries_id", "applications_id", "change_sets_id", "publish_snapshots_id", "publish_outbox_id", "published_releases_id" FROM \`payload_locked_documents_rels\`;`)
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
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_publish_snapshots_id_idx\` ON \`payload_locked_documents_rels\` (\`publish_snapshots_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_publish_outbox_id_idx\` ON \`payload_locked_documents_rels\` (\`publish_outbox_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_published_releases_id_idx\` ON \`payload_locked_documents_rels\` (\`published_releases_id\`);`)
  await db.run(sql`ALTER TABLE \`change_sets\` DROP COLUMN \`review_comments\`;`)
}
