import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`assets_texts\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer NOT NULL,
  	\`parent_id\` text(36) NOT NULL,
  	\`path\` text NOT NULL,
  	\`text\` text,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`assets_texts_order_parent\` ON \`assets_texts\` (\`order\`,\`parent_id\`);`)
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_assets\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`alt\` text,
  	\`decorative\` integer DEFAULT false,
  	\`caption\` text,
	\`private\` integer DEFAULT true,
	\`credit\` text,
  	\`deleted_at\` text,
  	\`delete_after\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`url\` text,
  	\`thumbnail_u_r_l\` text,
  	\`filename\` text,
  	\`mime_type\` text,
  	\`filesize\` numeric,
  	\`width\` numeric,
  	\`height\` numeric,
  	\`focal_x\` numeric DEFAULT 50,
  	\`focal_y\` numeric DEFAULT 50,
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
  	\`sizes_thumbnail_webp_filename\` text
  );
  `)
  await db.run(sql`INSERT INTO \`__new_assets\`("id", "alt", "caption", "private", "updated_at", "created_at") SELECT "id", "alt", "caption", "private", "updated_at", "created_at" FROM \`assets\`;`)
  await db.run(sql`DROP TABLE \`assets\`;`)
  await db.run(sql`ALTER TABLE \`__new_assets\` RENAME TO \`assets\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE INDEX \`assets_updated_at_idx\` ON \`assets\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`assets_created_at_idx\` ON \`assets\` (\`created_at\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`assets_filename_idx\` ON \`assets\` (\`filename\`);`)
  await db.run(sql`CREATE INDEX \`assets_sizes_hero_avif_sizes_hero_avif_filename_idx\` ON \`assets\` (\`sizes_hero_avif_filename\`);`)
  await db.run(sql`CREATE INDEX \`assets_sizes_hero_webp_sizes_hero_webp_filename_idx\` ON \`assets\` (\`sizes_hero_webp_filename\`);`)
  await db.run(sql`CREATE INDEX \`assets_sizes_card_avif_sizes_card_avif_filename_idx\` ON \`assets\` (\`sizes_card_avif_filename\`);`)
  await db.run(sql`CREATE INDEX \`assets_sizes_card_webp_sizes_card_webp_filename_idx\` ON \`assets\` (\`sizes_card_webp_filename\`);`)
  await db.run(sql`CREATE INDEX \`assets_sizes_thumbnail_avif_sizes_thumbnail_avif_filenam_idx\` ON \`assets\` (\`sizes_thumbnail_avif_filename\`);`)
  await db.run(sql`CREATE INDEX \`assets_sizes_thumbnail_webp_sizes_thumbnail_webp_filenam_idx\` ON \`assets\` (\`sizes_thumbnail_webp_filename\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`assets_texts\`;`)
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_assets\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`alt\` text NOT NULL,
  	\`caption\` text,
  	\`private\` integer DEFAULT true,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`INSERT INTO \`__new_assets\`("id", "alt", "caption", "private", "updated_at", "created_at") SELECT "id", "alt", "caption", "private", "updated_at", "created_at" FROM \`assets\`;`)
  await db.run(sql`DROP TABLE \`assets\`;`)
  await db.run(sql`ALTER TABLE \`__new_assets\` RENAME TO \`assets\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE INDEX \`assets_updated_at_idx\` ON \`assets\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`assets_created_at_idx\` ON \`assets\` (\`created_at\`);`)
}
