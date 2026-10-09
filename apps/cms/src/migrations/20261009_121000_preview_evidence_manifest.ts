import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-sqlite'
export async function up({ db }: MigrateUpArgs): Promise<void> { await db.run(sql`ALTER TABLE preview_render_jobs ADD evidence_manifest text;`) }
export async function down({ db }: MigrateDownArgs): Promise<void> { await db.run(sql`ALTER TABLE preview_render_jobs DROP COLUMN evidence_manifest;`) }
