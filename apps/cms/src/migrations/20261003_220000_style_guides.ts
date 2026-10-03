import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

/** Reviewed private style configuration. Published snapshots retain it as JSON. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`style_guides\` (\`id\` text(36) PRIMARY KEY NOT NULL, \`key\` text DEFAULT 'active' NOT NULL, \`banned_phrases\` text DEFAULT '[]' NOT NULL, \`preferred_terms\` text DEFAULT '[]' NOT NULL, \`canadian_spelling\` text DEFAULT 'off' NOT NULL, \`maximum_sentence_words\` numeric DEFAULT 30 NOT NULL, \`minimum_reading_ease\` numeric DEFAULT 30 NOT NULL, \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL);`)
  await db.run(sql`CREATE UNIQUE INDEX \`style_guides_key_idx\` ON \`style_guides\` (\`key\`);`)
  await db.run(sql`CREATE INDEX \`style_guides_updated_at_idx\` ON \`style_guides\` (\`updated_at\`);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`style_guides_id\` text(36) REFERENCES style_guides(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_style_guides_id_idx\` ON \`payload_locked_documents_rels\` (\`style_guides_id\`);`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`payload_locked_documents_rels_style_guides_id_idx\`;`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` DROP COLUMN \`style_guides_id\`;`)
  await db.run(sql`DROP TABLE \`style_guides\`;`)
}
