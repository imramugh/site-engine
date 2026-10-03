import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`invitations_roles\` (
    \`order\` integer NOT NULL,
    \`parent_id\` text(36) NOT NULL,
    \`value\` text,
    \`id\` text(36) PRIMARY KEY NOT NULL,
    FOREIGN KEY (\`parent_id\`) REFERENCES \`invitations\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`invitations_roles_order_idx\` ON \`invitations_roles\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`invitations_roles_parent_idx\` ON \`invitations_roles\` (\`parent_id\`);`)
  await db.run(sql`CREATE TABLE \`invitations\` (
    \`id\` text(36) PRIMARY KEY NOT NULL,
    \`email\` text NOT NULL,
    \`provider\` text NOT NULL,
    \`provider_subject\` text NOT NULL,
    \`expires_at\` text NOT NULL,
    \`accepted_at\` text,
    \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`invitations_email_idx\` ON \`invitations\` (\`email\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`invitations_provider_subject_idx\` ON \`invitations\` (\`provider_subject\`);`)
  await db.run(sql`CREATE INDEX \`invitations_updated_at_idx\` ON \`invitations\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`invitations_created_at_idx\` ON \`invitations\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`auth_sessions\` (
    \`id\` text(36) PRIMARY KEY NOT NULL,
    \`token_hash\` text NOT NULL,
    \`user_id\` text(36) NOT NULL,
    \`authenticated_at\` text NOT NULL,
    \`last_seen_at\` text NOT NULL,
    \`expires_at\` text NOT NULL,
    \`revoked_at\` text,
    \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`auth_sessions_token_hash_idx\` ON \`auth_sessions\` (\`token_hash\`);`)
  await db.run(sql`CREATE INDEX \`auth_sessions_user_idx\` ON \`auth_sessions\` (\`user_id\`);`)
  await db.run(sql`CREATE INDEX \`auth_sessions_updated_at_idx\` ON \`auth_sessions\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`auth_sessions_created_at_idx\` ON \`auth_sessions\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`auth_transactions\` (
    \`id\` text(36) PRIMARY KEY NOT NULL,
    \`state_hash\` text NOT NULL,
    \`nonce\` text NOT NULL,
    \`verifier\` text NOT NULL,
    \`provider\` text NOT NULL,
    \`expires_at\` text NOT NULL,
    \`consumed_at\` text,
    \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`auth_transactions_state_hash_idx\` ON \`auth_transactions\` (\`state_hash\`);`)
  await db.run(sql`CREATE INDEX \`auth_transactions_updated_at_idx\` ON \`auth_transactions\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`auth_transactions_created_at_idx\` ON \`auth_transactions\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`audit_events\` (
    \`id\` text(36) PRIMARY KEY NOT NULL,
    \`event\` text NOT NULL,
    \`user_id\` text(36),
    \`actor_id\` text(36),
    \`detail\` text,
    \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null,
    FOREIGN KEY (\`actor_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`audit_events_user_idx\` ON \`audit_events\` (\`user_id\`);`)
  await db.run(sql`CREATE INDEX \`audit_events_actor_idx\` ON \`audit_events\` (\`actor_id\`);`)
  await db.run(sql`CREATE INDEX \`audit_events_updated_at_idx\` ON \`audit_events\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`audit_events_created_at_idx\` ON \`audit_events\` (\`created_at\`);`)
  await db.run(sql`ALTER TABLE \`users\` ADD \`provider\` text;`)
  await db.run(sql`ALTER TABLE \`users\` ADD \`provider_subject\` text;`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`invitations_id\` text(36) REFERENCES invitations(id);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`auth_sessions_id\` text(36) REFERENCES auth_sessions(id);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`auth_transactions_id\` text(36) REFERENCES auth_transactions(id);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`audit_events_id\` text(36) REFERENCES audit_events(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_invitations_id_idx\` ON \`payload_locked_documents_rels\` (\`invitations_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_auth_sessions_id_idx\` ON \`payload_locked_documents_rels\` (\`auth_sessions_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_auth_transactions_id_idx\` ON \`payload_locked_documents_rels\` (\`auth_transactions_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_audit_events_id_idx\` ON \`payload_locked_documents_rels\` (\`audit_events_id\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`invitations_roles\`;`)
  await db.run(sql`DROP TABLE \`invitations\`;`)
  await db.run(sql`DROP TABLE \`auth_sessions\`;`)
  await db.run(sql`DROP TABLE \`auth_transactions\`;`)
  await db.run(sql`DROP TABLE \`audit_events\`;`)
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_payload_locked_documents_rels\` (
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
  await db.run(sql`INSERT INTO \`__new_payload_locked_documents_rels\`("id", "order", "parent_id", "path", "users_id", "pages_id", "sections_id", "assets_id", "redirects_id", "inquiries_id", "applications_id", "change_sets_id") SELECT "id", "order", "parent_id", "path", "users_id", "pages_id", "sections_id", "assets_id", "redirects_id", "inquiries_id", "applications_id", "change_sets_id" FROM \`payload_locked_documents_rels\`;`)
  await db.run(sql`DROP TABLE \`payload_locked_documents_rels\`;`)
  await db.run(sql`ALTER TABLE \`__new_payload_locked_documents_rels\` RENAME TO \`payload_locked_documents_rels\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
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
  await db.run(sql`ALTER TABLE \`users\` DROP COLUMN \`provider\`;`)
  await db.run(sql`ALTER TABLE \`users\` DROP COLUMN \`provider_subject\`;`)
}
