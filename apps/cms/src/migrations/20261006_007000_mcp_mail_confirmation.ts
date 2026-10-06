import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

/** Nullable expansion: legacy browser-only grants remain readable while MCP
 * grants carry both the assistant origin and the separate human confirmation. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE mail_drafts ADD assistant_client_i_d_hash text;`)
  await db.run(sql`ALTER TABLE mail_drafts ADD assistant_actor_id text(36) REFERENCES users(id);`)
  await db.run(sql`ALTER TABLE mail_drafts ADD assistant_o_auth_session_i_d text;`)
  await db.run(sql`ALTER TABLE mail_authorizations ADD human_confirmation_session_i_d text;`)
  await db.run(sql`ALTER TABLE mail_authorizations ADD assistant_client_i_d_hash text;`)
  await db.run(sql`ALTER TABLE mail_authorizations ADD assistant_actor_id text(36) REFERENCES users(id);`)
  await db.run(sql`ALTER TABLE mail_authorizations ADD assistant_o_auth_session_i_d text;`)
  await db.run(sql`CREATE INDEX mail_drafts_assistant_actor_idx ON mail_drafts (assistant_actor_id);`)
  await db.run(sql`CREATE INDEX mail_authorizations_assistant_actor_idx ON mail_authorizations (assistant_actor_id);`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  const drafts = await db.run(sql`SELECT COUNT(*) AS count FROM mail_drafts WHERE assistant_client_i_d_hash IS NOT NULL OR assistant_actor_id IS NOT NULL OR assistant_o_auth_session_i_d IS NOT NULL;`)
  const grants = await db.run(sql`SELECT COUNT(*) AS count FROM mail_authorizations WHERE human_confirmation_session_i_d IS NOT NULL OR assistant_client_i_d_hash IS NOT NULL OR assistant_actor_id IS NOT NULL OR assistant_o_auth_session_i_d IS NOT NULL;`)
  if (Number(drafts.rows[0]?.count ?? 0) || Number(grants.rows[0]?.count ?? 0)) throw new Error('Cannot roll back MCP mail-confirmation bindings while bound drafts or grants exist.')
  await db.run(sql`DROP INDEX mail_authorizations_assistant_actor_idx;`)
  await db.run(sql`DROP INDEX mail_drafts_assistant_actor_idx;`)
  await db.run(sql`ALTER TABLE mail_authorizations DROP COLUMN assistant_o_auth_session_i_d;`)
  await db.run(sql`ALTER TABLE mail_authorizations DROP COLUMN assistant_actor_id;`)
  await db.run(sql`ALTER TABLE mail_authorizations DROP COLUMN assistant_client_i_d_hash;`)
  await db.run(sql`ALTER TABLE mail_authorizations DROP COLUMN human_confirmation_session_i_d;`)
  await db.run(sql`ALTER TABLE mail_drafts DROP COLUMN assistant_o_auth_session_i_d;`)
  await db.run(sql`ALTER TABLE mail_drafts DROP COLUMN assistant_actor_id;`)
  await db.run(sql`ALTER TABLE mail_drafts DROP COLUMN assistant_client_i_d_hash;`)
}
