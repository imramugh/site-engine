import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'

/** Renderer diagnostics are bounded, internal evidence for a failed immutable preview. */
export async function up({ db }: MigrateUpArgs): Promise<void> { await db.run(sql`ALTER TABLE preview_render_jobs ADD render_diagnostics text;`) }
export async function down({ db }: MigrateDownArgs): Promise<void> {
  const used = await db.run(sql`SELECT COUNT(*) AS count FROM preview_render_jobs WHERE render_diagnostics IS NOT NULL;`)
  if (Number(used.rows[0]?.count ?? 0)) throw new Error('Cannot remove persisted preview diagnostics.')
  await db.run(sql`ALTER TABLE preview_render_jobs DROP COLUMN render_diagnostics;`)
}
