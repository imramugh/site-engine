import { sql } from 'drizzle-orm'
import type { MigrateUpArgs, MigrateDownArgs } from '@payloadcms/db-sqlite'
export async function up({ db }: MigrateUpArgs): Promise<void> { await db.run(sql`ALTER TABLE integration_configurations ADD COLUMN azure_resource_endpoint text;`); await db.run(sql`ALTER TABLE integration_configurations ADD COLUMN azure_api_version text;`) }
export async function down({ db }: MigrateDownArgs): Promise<void> { await db.run(sql`ALTER TABLE integration_configurations DROP COLUMN azure_resource_endpoint;`); await db.run(sql`ALTER TABLE integration_configurations DROP COLUMN azure_api_version;`) }
