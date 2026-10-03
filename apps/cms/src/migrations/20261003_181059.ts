import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`applications\` ADD \`name\` text NOT NULL DEFAULT 'Legacy applicant';`)
  await db.run(sql`ALTER TABLE \`applications\` ADD \`consent\` integer DEFAULT false NOT NULL;`)
  await db.run(sql`ALTER TABLE \`applications\` ADD \`job_id\` text NOT NULL DEFAULT 'legacy';`)
  await db.run(sql`ALTER TABLE \`applications\` ADD \`resume_key\` text NOT NULL DEFAULT 'legacy';`)
  await db.run(sql`ALTER TABLE \`applications\` ADD \`idempotency_key\` text NOT NULL DEFAULT '';`)
  await db.run(sql`UPDATE \`applications\` SET \`idempotency_key\` = 'legacy:' || \`id\` WHERE \`idempotency_key\` = '';`)
  await db.run(sql`CREATE UNIQUE INDEX \`applications_idempotency_key_idx\` ON \`applications\` (\`idempotency_key\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`applications_idempotency_key_idx\`;`)
  await db.run(sql`ALTER TABLE \`applications\` DROP COLUMN \`name\`;`)
  await db.run(sql`ALTER TABLE \`applications\` DROP COLUMN \`consent\`;`)
  await db.run(sql`ALTER TABLE \`applications\` DROP COLUMN \`job_id\`;`)
  await db.run(sql`ALTER TABLE \`applications\` DROP COLUMN \`resume_key\`;`)
  await db.run(sql`ALTER TABLE \`applications\` DROP COLUMN \`idempotency_key\`;`)
}
