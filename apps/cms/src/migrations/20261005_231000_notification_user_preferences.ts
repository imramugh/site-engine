import { sql, type MigrateDownArgs, type MigrateUpArgs } from '@payloadcms/db-sqlite'
export async function up({ db }: MigrateUpArgs) {
  await db.run(sql`CREATE TABLE notification_user_preferences (id text(36) PRIMARY KEY NOT NULL, user_id text(36) NOT NULL REFERENCES users(id), muted_kinds text NOT NULL DEFAULT '[]', updated_at text NOT NULL, created_at text NOT NULL);`)
  await db.run(sql`CREATE UNIQUE INDEX notification_user_preferences_user_idx ON notification_user_preferences (user_id);`)
  await db.run(sql`CREATE INDEX notification_user_preferences_updated_at_idx ON notification_user_preferences (updated_at);`)
  await db.run(sql`ALTER TABLE payload_locked_documents_rels ADD notification_user_preferences_id text(36) REFERENCES notification_user_preferences(id);`)
  await db.run(sql`CREATE INDEX payload_locked_documents_rels_notification_user_preferences_id_idx ON payload_locked_documents_rels (notification_user_preferences_id);`)
}
export async function down({ db }: MigrateDownArgs) { await db.run(sql`DROP INDEX payload_locked_documents_rels_notification_user_preferences_id_idx;`); await db.run(sql`ALTER TABLE payload_locked_documents_rels DROP COLUMN notification_user_preferences_id;`); await db.run(sql`DROP TABLE notification_user_preferences;`) }
