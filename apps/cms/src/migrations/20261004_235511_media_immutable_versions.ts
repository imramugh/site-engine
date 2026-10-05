import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`asset_file_versions\` (
    \`id\` text(36) PRIMARY KEY NOT NULL,
    \`parent_asset_id\` text(36) NOT NULL,
    \`digest\` text NOT NULL,
    \`version_key\` text NOT NULL,
    \`idempotency_key\` text NOT NULL,
    \`original_filename\` text NOT NULL,
    \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    \`url\` text,
    \`thumbnail_u_r_l\` text,
    \`filename\` text,
    \`mime_type\` text,
    \`filesize\` numeric,
    \`width\` numeric,
    \`height\` numeric,
    \`focal_x\` numeric,
    \`focal_y\` numeric,
    \`sizes_hero_avif_url\` text,
    \`sizes_hero_avif_width\` numeric,
    \`sizes_hero_avif_height\` numeric,
    \`sizes_hero_avif_mime_type\` text,
    \`sizes_hero_avif_filesize\` numeric,
    \`sizes_hero_avif_filename\` text,
    \`sizes_hero_webp_url\` text,
    \`sizes_hero_webp_width\` numeric,
    \`sizes_hero_webp_height\` numeric,
    \`sizes_hero_webp_mime_type\` text,
    \`sizes_hero_webp_filesize\` numeric,
    \`sizes_hero_webp_filename\` text,
    \`sizes_card_avif_url\` text,
    \`sizes_card_avif_width\` numeric,
    \`sizes_card_avif_height\` numeric,
    \`sizes_card_avif_mime_type\` text,
    \`sizes_card_avif_filesize\` numeric,
    \`sizes_card_avif_filename\` text,
    \`sizes_card_webp_url\` text,
    \`sizes_card_webp_width\` numeric,
    \`sizes_card_webp_height\` numeric,
    \`sizes_card_webp_mime_type\` text,
    \`sizes_card_webp_filesize\` numeric,
    \`sizes_card_webp_filename\` text,
    \`sizes_thumbnail_avif_url\` text,
    \`sizes_thumbnail_avif_width\` numeric,
    \`sizes_thumbnail_avif_height\` numeric,
    \`sizes_thumbnail_avif_mime_type\` text,
    \`sizes_thumbnail_avif_filesize\` numeric,
    \`sizes_thumbnail_avif_filename\` text,
    \`sizes_thumbnail_webp_url\` text,
    \`sizes_thumbnail_webp_width\` numeric,
    \`sizes_thumbnail_webp_height\` numeric,
    \`sizes_thumbnail_webp_mime_type\` text,
    \`sizes_thumbnail_webp_filesize\` numeric,
    \`sizes_thumbnail_webp_filename\` text,
  FOREIGN KEY (\`parent_asset_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`asset_file_versions_parent_asset_idx\` ON \`asset_file_versions\` (\`parent_asset_id\`);`)
  await db.run(sql`CREATE INDEX \`asset_file_versions_digest_idx\` ON \`asset_file_versions\` (\`digest\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`asset_file_versions_version_key_idx\` ON \`asset_file_versions\` (\`version_key\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`asset_file_versions_idempotency_key_idx\` ON \`asset_file_versions\` (\`idempotency_key\`);`)
  await db.run(sql`CREATE INDEX \`asset_file_versions_updated_at_idx\` ON \`asset_file_versions\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`asset_file_versions_created_at_idx\` ON \`asset_file_versions\` (\`created_at\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`asset_file_versions_filename_idx\` ON \`asset_file_versions\` (\`filename\`);`)
  await db.run(sql`CREATE INDEX \`asset_file_versions_sizes_hero_avif_sizes_hero_avif_file_idx\` ON \`asset_file_versions\` (\`sizes_hero_avif_filename\`);`)
  await db.run(sql`CREATE INDEX \`asset_file_versions_sizes_hero_webp_sizes_hero_webp_file_idx\` ON \`asset_file_versions\` (\`sizes_hero_webp_filename\`);`)
  await db.run(sql`CREATE INDEX \`asset_file_versions_sizes_card_avif_sizes_card_avif_file_idx\` ON \`asset_file_versions\` (\`sizes_card_avif_filename\`);`)
  await db.run(sql`CREATE INDEX \`asset_file_versions_sizes_card_webp_sizes_card_webp_file_idx\` ON \`asset_file_versions\` (\`sizes_card_webp_filename\`);`)
  await db.run(sql`CREATE INDEX \`asset_file_versions_sizes_thumbnail_avif_sizes_thumbnail_idx\` ON \`asset_file_versions\` (\`sizes_thumbnail_avif_filename\`);`)
  await db.run(sql`CREATE INDEX \`asset_file_versions_sizes_thumbnail_webp_sizes_thumbnail_idx\` ON \`asset_file_versions\` (\`sizes_thumbnail_webp_filename\`);`)
  await db.run(sql`ALTER TABLE \`assets\` ADD \`current_file_version_id\` text(36) REFERENCES asset_file_versions(id);`)
  await db.run(sql`ALTER TABLE \`assets\` ADD \`current_file\` text;`)
  await db.run(sql`CREATE INDEX \`assets_current_file_version_idx\` ON \`assets\` (\`current_file_version_id\`);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`asset_file_versions_id\` text(36) REFERENCES asset_file_versions(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_asset_file_versions_id_idx\` ON \`payload_locked_documents_rels\` (\`asset_file_versions_id\`);`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`payload_locked_documents_rels_asset_file_versions_id_idx\`;`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` DROP COLUMN \`asset_file_versions_id\`;`)
  await db.run(sql`DROP INDEX \`assets_current_file_version_idx\`;`)
  await db.run(sql`ALTER TABLE \`assets\` DROP COLUMN \`current_file_version_id\`;`)
  await db.run(sql`ALTER TABLE \`assets\` DROP COLUMN \`current_file\`;`)
  await db.run(sql`DROP TABLE \`asset_file_versions\`;`)
}
