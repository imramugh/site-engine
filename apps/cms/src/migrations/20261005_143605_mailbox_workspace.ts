import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`mailbox_configurations\` (
    \`id\` text(36) PRIMARY KEY NOT NULL,
    \`name\` text NOT NULL,
    \`provider\` text NOT NULL,
    \`primary_address\` text NOT NULL,
    \`aliases\` text DEFAULT '[]' NOT NULL,
    \`verified_aliases\` text DEFAULT '[]' NOT NULL,
    \`host\` text NOT NULL,
    \`port\` numeric NOT NULL,
    \`security\` text NOT NULL,
    \`username\` text NOT NULL,
    \`encrypted_credential\` text,
    \`credential_fingerprint\` text NOT NULL,
    \`health\` text DEFAULT 'unknown' NOT NULL,
    \`tested_at\` text,
    \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`mailbox_configurations_updated_at_idx\` ON \`mailbox_configurations\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`mailbox_configurations_created_at_idx\` ON \`mailbox_configurations\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`mailbox_area_mappings\` (
    \`id\` text(36) PRIMARY KEY NOT NULL,
    \`area\` text NOT NULL,
    \`mailbox_id\` text(36) NOT NULL,
    \`sender_address\` text NOT NULL,
    \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    FOREIGN KEY (\`mailbox_id\`) REFERENCES \`mailbox_configurations\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`mailbox_area_mappings_area_idx\` ON \`mailbox_area_mappings\` (\`area\`);`)
  await db.run(sql`CREATE INDEX \`mailbox_area_mappings_mailbox_idx\` ON \`mailbox_area_mappings\` (\`mailbox_id\`);`)
  await db.run(sql`CREATE INDEX \`mailbox_area_mappings_updated_at_idx\` ON \`mailbox_area_mappings\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`mailbox_area_mappings_created_at_idx\` ON \`mailbox_area_mappings\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`mailbox_test_sends\` (
    \`id\` text(36) PRIMARY KEY NOT NULL,
    \`request_key\` text NOT NULL,
    \`request_hash\` text NOT NULL,
    \`mailbox_id\` text(36) NOT NULL,
    \`sender_address\` text NOT NULL,
    \`recipient_address\` text NOT NULL,
    \`authorized_by_id\` text(36) NOT NULL,
    \`state\` text NOT NULL,
    \`provider_message_i_d\` text,
    \`failure_code\` text,
    \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    FOREIGN KEY (\`mailbox_id\`) REFERENCES \`mailbox_configurations\`(\`id\`) ON UPDATE no action ON DELETE set null,
    FOREIGN KEY (\`authorized_by_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`mailbox_test_sends_request_key_idx\` ON \`mailbox_test_sends\` (\`request_key\`);`)
  await db.run(sql`CREATE INDEX \`mailbox_test_sends_mailbox_idx\` ON \`mailbox_test_sends\` (\`mailbox_id\`);`)
  await db.run(sql`CREATE INDEX \`mailbox_test_sends_authorized_by_idx\` ON \`mailbox_test_sends\` (\`authorized_by_id\`);`)
  await db.run(sql`CREATE INDEX \`mailbox_test_sends_updated_at_idx\` ON \`mailbox_test_sends\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`mailbox_test_sends_created_at_idx\` ON \`mailbox_test_sends\` (\`created_at\`);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`mailbox_configurations_id\` text(36) REFERENCES mailbox_configurations(id);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`mailbox_area_mappings_id\` text(36) REFERENCES mailbox_area_mappings(id);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`mailbox_test_sends_id\` text(36) REFERENCES mailbox_test_sends(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_mailbox_configurations_id_idx\` ON \`payload_locked_documents_rels\` (\`mailbox_configurations_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_mailbox_area_mappings_id_idx\` ON \`payload_locked_documents_rels\` (\`mailbox_area_mappings_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_mailbox_test_sends_id_idx\` ON \`payload_locked_documents_rels\` (\`mailbox_test_sends_id\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`mailbox_test_sends\`;`)
  await db.run(sql`DROP TABLE \`mailbox_area_mappings\`;`)
  await db.run(sql`DROP TABLE \`mailbox_configurations\`;`)
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
    \`notification_preferences_id\` text(36),
    \`urgent_contacts_id\` text(36),
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
    FOREIGN KEY (\`notification_preferences_id\`) REFERENCES \`notification_preferences\`(\`id\`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (\`urgent_contacts_id\`) REFERENCES \`urgent_contacts\`(\`id\`) ON UPDATE no action ON DELETE cascade,
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
  await db.run(sql`INSERT INTO \`__new_payload_locked_documents_rels\`("id", "order", "parent_id", "path", "users_id", "invitations_id", "auth_sessions_id", "auth_transactions_id", "audit_events_id", "pages_id", "sections_id", "assets_id", "asset_file_versions_id", "redirects_id", "theme_settings_id", "site_settings_id", "style_guides_id", "integration_configurations_id", "provider_usage_reservations_id", "inquiries_id", "notification_outbox_id", "notification_preferences_id", "urgent_contacts_id", "mail_drafts_id", "mail_authorizations_id", "applications_id", "change_sets_id", "configured_ai_jobs_id", "publish_snapshots_id", "publish_outbox_id", "scheduled_publications_id", "preview_render_jobs_id", "published_releases_id") SELECT "id", "order", "parent_id", "path", "users_id", "invitations_id", "auth_sessions_id", "auth_transactions_id", "audit_events_id", "pages_id", "sections_id", "assets_id", "asset_file_versions_id", "redirects_id", "theme_settings_id", "site_settings_id", "style_guides_id", "integration_configurations_id", "provider_usage_reservations_id", "inquiries_id", "notification_outbox_id", "notification_preferences_id", "urgent_contacts_id", "mail_drafts_id", "mail_authorizations_id", "applications_id", "change_sets_id", "configured_ai_jobs_id", "publish_snapshots_id", "publish_outbox_id", "scheduled_publications_id", "preview_render_jobs_id", "published_releases_id" FROM \`payload_locked_documents_rels\`;`)
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
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_asset_file_versions_id_idx\` ON \`payload_locked_documents_rels\` (\`asset_file_versions_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_redirects_id_idx\` ON \`payload_locked_documents_rels\` (\`redirects_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_theme_settings_id_idx\` ON \`payload_locked_documents_rels\` (\`theme_settings_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_site_settings_id_idx\` ON \`payload_locked_documents_rels\` (\`site_settings_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_style_guides_id_idx\` ON \`payload_locked_documents_rels\` (\`style_guides_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_integration_configurations_idx\` ON \`payload_locked_documents_rels\` (\`integration_configurations_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_provider_usage_reservation_idx\` ON \`payload_locked_documents_rels\` (\`provider_usage_reservations_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_inquiries_id_idx\` ON \`payload_locked_documents_rels\` (\`inquiries_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_notification_outbox_id_idx\` ON \`payload_locked_documents_rels\` (\`notification_outbox_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_notification_preferences_i_idx\` ON \`payload_locked_documents_rels\` (\`notification_preferences_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_urgent_contacts_id_idx\` ON \`payload_locked_documents_rels\` (\`urgent_contacts_id\`);`)
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
}
