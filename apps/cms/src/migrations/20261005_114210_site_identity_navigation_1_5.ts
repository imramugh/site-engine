import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`legal_name\` text;`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`logos_primary_light_id\` text(36) REFERENCES assets(id);`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`logos_primary_dark_id\` text(36) REFERENCES assets(id);`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`logos_full_lockup_light_id\` text(36) REFERENCES assets(id);`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`logos_full_lockup_dark_id\` text(36) REFERENCES assets(id);`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`logos_symbol_light_id\` text(36) REFERENCES assets(id);`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`logos_symbol_dark_id\` text(36) REFERENCES assets(id);`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`address_street_address\` text;`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`address_address_locality\` text;`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`address_address_region\` text;`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`address_postal_code\` text;`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`address_address_country\` text DEFAULT 'CA';`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`linked_in\` text;`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`incident_label\` text;`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`incident_guidance\` text;`)
  await db.run(sql`ALTER TABLE \`site_settings\` ADD \`navigation\` text;`)
  await db.run(sql`CREATE INDEX \`site_settings_logos_logos_primary_light_idx\` ON \`site_settings\` (\`logos_primary_light_id\`);`)
  await db.run(sql`CREATE INDEX \`site_settings_logos_logos_primary_dark_idx\` ON \`site_settings\` (\`logos_primary_dark_id\`);`)
  await db.run(sql`CREATE INDEX \`site_settings_logos_logos_full_lockup_light_idx\` ON \`site_settings\` (\`logos_full_lockup_light_id\`);`)
  await db.run(sql`CREATE INDEX \`site_settings_logos_logos_full_lockup_dark_idx\` ON \`site_settings\` (\`logos_full_lockup_dark_id\`);`)
  await db.run(sql`CREATE INDEX \`site_settings_logos_logos_symbol_light_idx\` ON \`site_settings\` (\`logos_symbol_light_id\`);`)
  await db.run(sql`CREATE INDEX \`site_settings_logos_logos_symbol_dark_idx\` ON \`site_settings\` (\`logos_symbol_dark_id\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_site_settings\` (
  	\`id\` text(36) PRIMARY KEY NOT NULL,
  	\`key\` text DEFAULT 'active' NOT NULL,
  	\`site_name\` text NOT NULL,
  	\`homepage_id_id\` text(36),
  	\`default_locale\` text NOT NULL,
  	\`organization_type\` text,
  	\`logo_id\` text(36),
  	\`contact_email\` text,
  	\`contact_phone\` text,
  	\`seo_description\` text,
  	\`search_enabled\` integer DEFAULT false,
  	\`contract_version\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`homepage_id_id\`) REFERENCES \`pages\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`logo_id\`) REFERENCES \`assets\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`INSERT INTO \`__new_site_settings\`("id", "key", "site_name", "homepage_id_id", "default_locale", "organization_type", "logo_id", "contact_email", "contact_phone", "seo_description", "search_enabled", "contract_version", "updated_at", "created_at") SELECT "id", "key", "site_name", "homepage_id_id", "default_locale", "organization_type", "logo_id", "contact_email", "contact_phone", "seo_description", "search_enabled", "contract_version", "updated_at", "created_at" FROM \`site_settings\`;`)
  await db.run(sql`DROP TABLE \`site_settings\`;`)
  await db.run(sql`ALTER TABLE \`__new_site_settings\` RENAME TO \`site_settings\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE UNIQUE INDEX \`site_settings_key_idx\` ON \`site_settings\` (\`key\`);`)
  await db.run(sql`CREATE INDEX \`site_settings_homepage_id_idx\` ON \`site_settings\` (\`homepage_id_id\`);`)
  await db.run(sql`CREATE INDEX \`site_settings_logo_idx\` ON \`site_settings\` (\`logo_id\`);`)
  await db.run(sql`CREATE INDEX \`site_settings_updated_at_idx\` ON \`site_settings\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`site_settings_created_at_idx\` ON \`site_settings\` (\`created_at\`);`)
}
