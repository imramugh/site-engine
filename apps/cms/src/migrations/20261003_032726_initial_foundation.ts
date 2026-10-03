import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`users_roles\` (
  	\`order\` integer NOT NULL,
  	\`parent_id\` text(36) NOT NULL,
  	\`value\` text,
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`users_roles_order_idx\` ON \`users_roles\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`users_roles_parent_idx\` ON \`users_roles\` (\`parent_id\`);`)
  await db.run(sql`CREATE TABLE \`users\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  	\`disabled\` integer DEFAULT false,
  	\`invited_at\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`users_updated_at_idx\` ON \`users\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`users_created_at_idx\` ON \`users\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`pages\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`title\` text,
  	\`slug\` text,
  	\`section_id_id\` text(36),
  	\`parent_id_id\` text(36),
  	\`summary\` text,
  	\`template\` text DEFAULT 'standard',
  	\`status\` text DEFAULT 'draft',
  	\`blocks\` text DEFAULT '[]',
  	\`seo_description\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`_status\` text DEFAULT 'draft',
  	FOREIGN KEY (\`section_id_id\`) REFERENCES \`sections\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`parent_id_id\`) REFERENCES \`pages\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`pages_slug_idx\` ON \`pages\` (\`slug\`);`)
  await db.run(sql`CREATE INDEX \`pages_section_id_idx\` ON \`pages\` (\`section_id_id\`);`)
  await db.run(sql`CREATE INDEX \`pages_parent_id_idx\` ON \`pages\` (\`parent_id_id\`);`)
  await db.run(sql`CREATE INDEX \`pages_updated_at_idx\` ON \`pages\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`pages_created_at_idx\` ON \`pages\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`pages__status_idx\` ON \`pages\` (\`_status\`);`)
  await db.run(sql`CREATE TABLE \`_pages_v\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`parent_id\` text(36),
  	\`version_title\` text,
  	\`version_slug\` text,
  	\`version_section_id_id\` text(36),
  	\`version_parent_id_id\` text(36),
  	\`version_summary\` text,
  	\`version_template\` text DEFAULT 'standard',
  	\`version_status\` text DEFAULT 'draft',
  	\`version_blocks\` text DEFAULT '[]',
  	\`version_seo_description\` text,
  	\`version_updated_at\` text,
  	\`version_created_at\` text,
  	\`version__status\` text DEFAULT 'draft',
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`latest\` integer,
  	\`autosave\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`pages\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`version_section_id_id\`) REFERENCES \`sections\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`version_parent_id_id\`) REFERENCES \`pages\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`_pages_v_parent_idx\` ON \`_pages_v\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_slug_idx\` ON \`_pages_v\` (\`version_slug\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_section_id_idx\` ON \`_pages_v\` (\`version_section_id_id\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_parent_id_idx\` ON \`_pages_v\` (\`version_parent_id_id\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_updated_at_idx\` ON \`_pages_v\` (\`version_updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_created_at_idx\` ON \`_pages_v\` (\`version_created_at\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version__status_idx\` ON \`_pages_v\` (\`version__status\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_created_at_idx\` ON \`_pages_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_updated_at_idx\` ON \`_pages_v\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_latest_idx\` ON \`_pages_v\` (\`latest\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_autosave_idx\` ON \`_pages_v\` (\`autosave\`);`)
  await db.run(sql`CREATE TABLE \`sections_allowed_templates\` (
  	\`order\` integer NOT NULL,
  	\`parent_id\` text(36) NOT NULL,
  	\`value\` text,
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`sections\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`sections_allowed_templates_order_idx\` ON \`sections_allowed_templates\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`sections_allowed_templates_parent_idx\` ON \`sections_allowed_templates\` (\`parent_id\`);`)
  await db.run(sql`CREATE TABLE \`sections\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`name\` text,
  	\`slug\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`_status\` text DEFAULT 'draft'
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`sections_slug_idx\` ON \`sections\` (\`slug\`);`)
  await db.run(sql`CREATE INDEX \`sections_updated_at_idx\` ON \`sections\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`sections_created_at_idx\` ON \`sections\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`sections__status_idx\` ON \`sections\` (\`_status\`);`)
  await db.run(sql`CREATE TABLE \`sections_rels\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer,
  	\`parent_id\` text(36) NOT NULL,
  	\`path\` text NOT NULL,
  	\`pages_id\` text(36),
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`sections\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`pages_id\`) REFERENCES \`pages\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`sections_rels_order_idx\` ON \`sections_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`sections_rels_parent_idx\` ON \`sections_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`sections_rels_path_idx\` ON \`sections_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX \`sections_rels_pages_id_idx\` ON \`sections_rels\` (\`pages_id\`);`)
  await db.run(sql`CREATE TABLE \`_sections_v_version_allowed_templates\` (
  	\`order\` integer NOT NULL,
  	\`parent_id\` text(36) NOT NULL,
  	\`value\` text,
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`_sections_v\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`_sections_v_version_allowed_templates_order_idx\` ON \`_sections_v_version_allowed_templates\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_version_allowed_templates_parent_idx\` ON \`_sections_v_version_allowed_templates\` (\`parent_id\`);`)
  await db.run(sql`CREATE TABLE \`_sections_v\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`parent_id\` text(36),
  	\`version_name\` text,
  	\`version_slug\` text,
  	\`version_updated_at\` text,
  	\`version_created_at\` text,
  	\`version__status\` text DEFAULT 'draft',
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`latest\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`sections\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`_sections_v_parent_idx\` ON \`_sections_v\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_version_version_slug_idx\` ON \`_sections_v\` (\`version_slug\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_version_version_updated_at_idx\` ON \`_sections_v\` (\`version_updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_version_version_created_at_idx\` ON \`_sections_v\` (\`version_created_at\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_version_version__status_idx\` ON \`_sections_v\` (\`version__status\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_created_at_idx\` ON \`_sections_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_updated_at_idx\` ON \`_sections_v\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_latest_idx\` ON \`_sections_v\` (\`latest\`);`)
  await db.run(sql`CREATE TABLE \`_sections_v_rels\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer,
  	\`parent_id\` text(36) NOT NULL,
  	\`path\` text NOT NULL,
  	\`pages_id\` text(36),
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`_sections_v\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`pages_id\`) REFERENCES \`pages\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`_sections_v_rels_order_idx\` ON \`_sections_v_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_rels_parent_idx\` ON \`_sections_v_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_rels_path_idx\` ON \`_sections_v_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_rels_pages_id_idx\` ON \`_sections_v_rels\` (\`pages_id\`);`)
  await db.run(sql`CREATE TABLE \`assets\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`alt\` text NOT NULL,
  	\`caption\` text,
  	\`private\` integer DEFAULT true,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`assets_updated_at_idx\` ON \`assets\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`assets_created_at_idx\` ON \`assets\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`redirects\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`from\` text NOT NULL,
  	\`to\` text NOT NULL,
  	\`status\` numeric DEFAULT 301,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`redirects_from_idx\` ON \`redirects\` (\`from\`);`)
  await db.run(sql`CREATE INDEX \`redirects_updated_at_idx\` ON \`redirects\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`redirects_created_at_idx\` ON \`redirects\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`inquiries\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`email\` text NOT NULL,
  	\`message\` text NOT NULL,
  	\`status\` text DEFAULT 'new',
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`inquiries_updated_at_idx\` ON \`inquiries\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`inquiries_created_at_idx\` ON \`inquiries\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`applications\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`email\` text NOT NULL,
  	\`cover_letter\` text NOT NULL,
  	\`status\` text DEFAULT 'new',
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`applications_updated_at_idx\` ON \`applications\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`applications_created_at_idx\` ON \`applications\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`change_sets\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  	\`state\` text DEFAULT 'draft',
  	\`revision\` numeric DEFAULT 0,
  	\`summary\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`change_sets_updated_at_idx\` ON \`change_sets\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`change_sets_created_at_idx\` ON \`change_sets\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`payload_kv\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`key\` text NOT NULL,
  	\`data\` text NOT NULL
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`payload_kv_key_idx\` ON \`payload_kv\` (\`key\`);`)
  await db.run(sql`CREATE TABLE \`payload_locked_documents\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`global_slug\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_global_slug_idx\` ON \`payload_locked_documents\` (\`global_slug\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_updated_at_idx\` ON \`payload_locked_documents\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_created_at_idx\` ON \`payload_locked_documents\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`payload_locked_documents_rels\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer,
  	\`parent_id\` text(36) NOT NULL,
  	\`path\` text NOT NULL,
  	\`users_id\` text(36),
  	\`pages_id\` text(36),
  	\`sections_id\` text(36),
  	\`assets_id\` text(36),
  	\`redirects_id\` text(36),
  	\`inquiries_id\` text(36),
  	\`applications_id\` text(36),
  	\`change_sets_id\` text(36),
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`payload_locked_documents\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`users_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`pages_id\`) REFERENCES \`pages\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`sections_id\`) REFERENCES \`sections\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`assets_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`redirects_id\`) REFERENCES \`redirects\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`inquiries_id\`) REFERENCES \`inquiries\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`applications_id\`) REFERENCES \`applications\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`change_sets_id\`) REFERENCES \`change_sets\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_order_idx\` ON \`payload_locked_documents_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_parent_idx\` ON \`payload_locked_documents_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_path_idx\` ON \`payload_locked_documents_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_users_id_idx\` ON \`payload_locked_documents_rels\` (\`users_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_pages_id_idx\` ON \`payload_locked_documents_rels\` (\`pages_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_sections_id_idx\` ON \`payload_locked_documents_rels\` (\`sections_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_assets_id_idx\` ON \`payload_locked_documents_rels\` (\`assets_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_redirects_id_idx\` ON \`payload_locked_documents_rels\` (\`redirects_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_inquiries_id_idx\` ON \`payload_locked_documents_rels\` (\`inquiries_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_applications_id_idx\` ON \`payload_locked_documents_rels\` (\`applications_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_change_sets_id_idx\` ON \`payload_locked_documents_rels\` (\`change_sets_id\`);`)
  await db.run(sql`CREATE TABLE \`payload_preferences\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`key\` text,
  	\`value\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`payload_preferences_key_idx\` ON \`payload_preferences\` (\`key\`);`)
  await db.run(sql`CREATE INDEX \`payload_preferences_updated_at_idx\` ON \`payload_preferences\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`payload_preferences_created_at_idx\` ON \`payload_preferences\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`payload_preferences_rels\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer,
  	\`parent_id\` text(36) NOT NULL,
  	\`path\` text NOT NULL,
  	\`users_id\` text(36),
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`payload_preferences\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`users_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`payload_preferences_rels_order_idx\` ON \`payload_preferences_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`payload_preferences_rels_parent_idx\` ON \`payload_preferences_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_preferences_rels_path_idx\` ON \`payload_preferences_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX \`payload_preferences_rels_users_id_idx\` ON \`payload_preferences_rels\` (\`users_id\`);`)
  await db.run(sql`CREATE TABLE \`payload_migrations\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`name\` text,
  	\`batch\` numeric,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`payload_migrations_updated_at_idx\` ON \`payload_migrations\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`payload_migrations_created_at_idx\` ON \`payload_migrations\` (\`created_at\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`users_roles\`;`)
  await db.run(sql`DROP TABLE \`users\`;`)
  await db.run(sql`DROP TABLE \`pages\`;`)
  await db.run(sql`DROP TABLE \`_pages_v\`;`)
  await db.run(sql`DROP TABLE \`sections_allowed_templates\`;`)
  await db.run(sql`DROP TABLE \`sections\`;`)
  await db.run(sql`DROP TABLE \`sections_rels\`;`)
  await db.run(sql`DROP TABLE \`_sections_v_version_allowed_templates\`;`)
  await db.run(sql`DROP TABLE \`_sections_v\`;`)
  await db.run(sql`DROP TABLE \`_sections_v_rels\`;`)
  await db.run(sql`DROP TABLE \`assets\`;`)
  await db.run(sql`DROP TABLE \`redirects\`;`)
  await db.run(sql`DROP TABLE \`inquiries\`;`)
  await db.run(sql`DROP TABLE \`applications\`;`)
  await db.run(sql`DROP TABLE \`change_sets\`;`)
  await db.run(sql`DROP TABLE \`payload_kv\`;`)
  await db.run(sql`DROP TABLE \`payload_locked_documents\`;`)
  await db.run(sql`DROP TABLE \`payload_locked_documents_rels\`;`)
  await db.run(sql`DROP TABLE \`payload_preferences\`;`)
  await db.run(sql`DROP TABLE \`payload_preferences_rels\`;`)
  await db.run(sql`DROP TABLE \`payload_migrations\`;`)
}
