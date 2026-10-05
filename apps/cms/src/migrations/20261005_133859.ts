import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`notification_preferences\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`key\` text NOT NULL,
  	\`events\` text NOT NULL,
  	\`updated_by_id\` text(36) NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`updated_by_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`notification_preferences_key_idx\` ON \`notification_preferences\` (\`key\`);`)
  await db.run(sql`CREATE INDEX \`notification_preferences_updated_by_idx\` ON \`notification_preferences\` (\`updated_by_id\`);`)
  await db.run(sql`CREATE INDEX \`notification_preferences_updated_at_idx\` ON \`notification_preferences\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`notification_preferences_created_at_idx\` ON \`notification_preferences\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`urgent_contacts\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  	\`email\` text NOT NULL,
  	\`mobile\` text,
  	\`enabled\` integer DEFAULT true NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`urgent_contacts_updated_at_idx\` ON \`urgent_contacts\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`urgent_contacts_created_at_idx\` ON \`urgent_contacts\` (\`created_at\`);`)
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_notification_outbox\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`inquiry_id\` text(36),
  	\`kind\` text NOT NULL,
  	\`idempotency_key\` text NOT NULL,
  	\`state\` text DEFAULT 'queued' NOT NULL,
  	\`payload\` text NOT NULL,
  	\`recipient_rules\` text NOT NULL,
  	\`recipients\` text NOT NULL,
  	\`channels\` text NOT NULL,
  	\`source_type\` text,
  	\`source_i_d\` text,
  	\`available_at\` text NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`inquiry_id\`) REFERENCES \`inquiries\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`INSERT INTO \`__new_notification_outbox\`("id", "inquiry_id", "kind", "idempotency_key", "state", "payload", "recipient_rules", "recipients", "channels", "source_type", "source_i_d", "available_at", "updated_at", "created_at")
    SELECT "id", "inquiry_id",
      CASE "kind" WHEN 'lead-received' THEN 'new-lead' WHEN 'urgent-lead-alert' THEN 'active-incident-lead' ELSE "kind" END,
      "idempotency_key", "state", "payload",
      CASE "kind" WHEN 'lead-received' THEN '["owner","sales"]' WHEN 'urgent-lead-alert' THEN '["urgent-contact","owner"]' ELSE '[]' END,
      '[]', CASE "kind" WHEN 'urgent-lead-alert' THEN '["email","sms"]' ELSE '["email"]' END,
      'inquiry', "inquiry_id", "available_at", "updated_at", "created_at"
    FROM \`notification_outbox\`;`)
  await db.run(sql`DROP TABLE \`notification_outbox\`;`)
  await db.run(sql`ALTER TABLE \`__new_notification_outbox\` RENAME TO \`notification_outbox\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE INDEX \`notification_outbox_inquiry_idx\` ON \`notification_outbox\` (\`inquiry_id\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`notification_outbox_idempotency_key_idx\` ON \`notification_outbox\` (\`idempotency_key\`);`)
  await db.run(sql`CREATE INDEX \`notification_outbox_updated_at_idx\` ON \`notification_outbox\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`notification_outbox_created_at_idx\` ON \`notification_outbox\` (\`created_at\`);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`notification_preferences_id\` text(36) REFERENCES notification_preferences(id);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`urgent_contacts_id\` text(36) REFERENCES urgent_contacts(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_notification_preferences_i_idx\` ON \`payload_locked_documents_rels\` (\`notification_preferences_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_urgent_contacts_id_idx\` ON \`payload_locked_documents_rels\` (\`urgent_contacts_id\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
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
  	\`asset_file_versions_id\` text(36),
  	\`redirects_id\` text(36),
  	\`theme_settings_id\` text(36),
  	\`site_settings_id\` text(36),
  	\`style_guides_id\` text(36),
  	\`integration_configurations_id\` text(36),
  	\`provider_usage_reservations_id\` text(36),
  	\`inquiries_id\` text(36),
  	\`notification_outbox_id\` text(36),
  	\`mail_drafts_id\` text(36),
  	\`mail_authorizations_id\` text(36),
  	\`applications_id\` text(36),
  	\`change_sets_id\` text(36),
  	\`configured_ai_jobs_id\` text(36),
  	\`publish_snapshots_id\` text(36),
  	\`publish_outbox_id\` text(36),
  	\`scheduled_publications_id\` text(36),
  	\`preview_render_jobs_id\` text(36),
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
  	FOREIGN KEY (\`asset_file_versions_id\`) REFERENCES \`asset_file_versions\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`redirects_id\`) REFERENCES \`redirects\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`theme_settings_id\`) REFERENCES \`theme_settings\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`site_settings_id\`) REFERENCES \`site_settings\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`style_guides_id\`) REFERENCES \`style_guides\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`integration_configurations_id\`) REFERENCES \`integration_configurations\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`provider_usage_reservations_id\`) REFERENCES \`provider_usage_reservations\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`inquiries_id\`) REFERENCES \`inquiries\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`notification_outbox_id\`) REFERENCES \`notification_outbox\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`mail_drafts_id\`) REFERENCES \`mail_drafts\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`mail_authorizations_id\`) REFERENCES \`mail_authorizations\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`applications_id\`) REFERENCES \`applications\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`change_sets_id\`) REFERENCES \`change_sets\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`configured_ai_jobs_id\`) REFERENCES \`configured_ai_jobs\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`publish_snapshots_id\`) REFERENCES \`publish_snapshots\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`publish_outbox_id\`) REFERENCES \`publish_outbox\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`scheduled_publications_id\`) REFERENCES \`scheduled_publications\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`preview_render_jobs_id\`) REFERENCES \`preview_render_jobs\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`published_releases_id\`) REFERENCES \`published_releases\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`INSERT INTO \`__new_payload_locked_documents_rels\`("id", "order", "parent_id", "path", "users_id", "invitations_id", "auth_sessions_id", "auth_transactions_id", "audit_events_id", "pages_id", "sections_id", "assets_id", "asset_file_versions_id", "redirects_id", "theme_settings_id", "site_settings_id", "style_guides_id", "integration_configurations_id", "provider_usage_reservations_id", "inquiries_id", "notification_outbox_id", "mail_drafts_id", "mail_authorizations_id", "applications_id", "change_sets_id", "configured_ai_jobs_id", "publish_snapshots_id", "publish_outbox_id", "scheduled_publications_id", "preview_render_jobs_id", "published_releases_id") SELECT "id", "order", "parent_id", "path", "users_id", "invitations_id", "auth_sessions_id", "auth_transactions_id", "audit_events_id", "pages_id", "sections_id", "assets_id", "asset_file_versions_id", "redirects_id", "theme_settings_id", "site_settings_id", "style_guides_id", "integration_configurations_id", "provider_usage_reservations_id", "inquiries_id", "notification_outbox_id", "mail_drafts_id", "mail_authorizations_id", "applications_id", "change_sets_id", "configured_ai_jobs_id", "publish_snapshots_id", "publish_outbox_id", "scheduled_publications_id", "preview_render_jobs_id", "published_releases_id" FROM \`payload_locked_documents_rels\`;`)
  await db.run(sql`DROP TABLE \`payload_locked_documents_rels\`;`)
  await db.run(sql`ALTER TABLE \`__new_payload_locked_documents_rels\` RENAME TO \`payload_locked_documents_rels\`;`)
  await db.run(sql`DROP TABLE \`notification_preferences\`;`)
  await db.run(sql`DROP TABLE \`urgent_contacts\`;`)
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
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_asset_file_versions_id_idx\` ON \`payload_locked_documents_rels\` (\`asset_file_versions_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_redirects_id_idx\` ON \`payload_locked_documents_rels\` (\`redirects_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_theme_settings_id_idx\` ON \`payload_locked_documents_rels\` (\`theme_settings_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_site_settings_id_idx\` ON \`payload_locked_documents_rels\` (\`site_settings_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_style_guides_id_idx\` ON \`payload_locked_documents_rels\` (\`style_guides_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_integration_configurations_idx\` ON \`payload_locked_documents_rels\` (\`integration_configurations_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_provider_usage_reservation_idx\` ON \`payload_locked_documents_rels\` (\`provider_usage_reservations_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_inquiries_id_idx\` ON \`payload_locked_documents_rels\` (\`inquiries_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_notification_outbox_id_idx\` ON \`payload_locked_documents_rels\` (\`notification_outbox_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_mail_drafts_id_idx\` ON \`payload_locked_documents_rels\` (\`mail_drafts_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_mail_authorizations_id_idx\` ON \`payload_locked_documents_rels\` (\`mail_authorizations_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_applications_id_idx\` ON \`payload_locked_documents_rels\` (\`applications_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_change_sets_id_idx\` ON \`payload_locked_documents_rels\` (\`change_sets_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_configured_ai_jobs_id_idx\` ON \`payload_locked_documents_rels\` (\`configured_ai_jobs_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_publish_snapshots_id_idx\` ON \`payload_locked_documents_rels\` (\`publish_snapshots_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_publish_outbox_id_idx\` ON \`payload_locked_documents_rels\` (\`publish_outbox_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_scheduled_publications_id_idx\` ON \`payload_locked_documents_rels\` (\`scheduled_publications_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_preview_render_jobs_id_idx\` ON \`payload_locked_documents_rels\` (\`preview_render_jobs_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_published_releases_id_idx\` ON \`payload_locked_documents_rels\` (\`published_releases_id\`);`)
  await db.run(sql`CREATE TABLE \`__new_notification_outbox\` (
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
  await db.run(sql`INSERT INTO \`__new_notification_outbox\`("id", "inquiry_id", "kind", "idempotency_key", "state", "payload", "available_at", "updated_at", "created_at") SELECT "id", "inquiry_id", CASE "kind" WHEN 'new-lead' THEN 'lead-received' WHEN 'active-incident-lead' THEN 'urgent-lead-alert' ELSE "kind" END, "idempotency_key", "state", "payload", "available_at", "updated_at", "created_at" FROM \`notification_outbox\`;`)
  await db.run(sql`DROP TABLE \`notification_outbox\`;`)
  await db.run(sql`ALTER TABLE \`__new_notification_outbox\` RENAME TO \`notification_outbox\`;`)
  await db.run(sql`CREATE INDEX \`notification_outbox_inquiry_idx\` ON \`notification_outbox\` (\`inquiry_id\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`notification_outbox_idempotency_key_idx\` ON \`notification_outbox\` (\`idempotency_key\`);`)
  await db.run(sql`CREATE INDEX \`notification_outbox_updated_at_idx\` ON \`notification_outbox\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`notification_outbox_created_at_idx\` ON \`notification_outbox\` (\`created_at\`);`)
}
