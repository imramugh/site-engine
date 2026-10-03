import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`invitations\` ADD \`token_hash\` text NOT NULL;`)
  await db.run(sql`CREATE UNIQUE INDEX \`invitations_token_hash_idx\` ON \`invitations\` (\`token_hash\`);`)
  await db.run(sql`ALTER TABLE \`auth_transactions\` ADD \`invitation_id\` text(36) NOT NULL REFERENCES invitations(id);`)
  await db.run(sql`CREATE INDEX \`auth_transactions_invitation_idx\` ON \`auth_transactions\` (\`invitation_id\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_auth_transactions\` (
    \`id\` text(36) PRIMARY KEY NOT NULL,
    \`state_hash\` text NOT NULL,
    \`nonce\` text NOT NULL,
    \`verifier\` text NOT NULL,
    \`provider\` text NOT NULL,
    \`expires_at\` text NOT NULL,
    \`consumed_at\` text,
    \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`INSERT INTO \`__new_auth_transactions\`("id", "state_hash", "nonce", "verifier", "provider", "expires_at", "consumed_at", "updated_at", "created_at") SELECT "id", "state_hash", "nonce", "verifier", "provider", "expires_at", "consumed_at", "updated_at", "created_at" FROM \`auth_transactions\`;`)
  await db.run(sql`DROP TABLE \`auth_transactions\`;`)
  await db.run(sql`ALTER TABLE \`__new_auth_transactions\` RENAME TO \`auth_transactions\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE UNIQUE INDEX \`auth_transactions_state_hash_idx\` ON \`auth_transactions\` (\`state_hash\`);`)
  await db.run(sql`CREATE INDEX \`auth_transactions_updated_at_idx\` ON \`auth_transactions\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`auth_transactions_created_at_idx\` ON \`auth_transactions\` (\`created_at\`);`)
  await db.run(sql`DROP INDEX \`invitations_token_hash_idx\`;`)
  await db.run(sql`ALTER TABLE \`invitations\` DROP COLUMN \`token_hash\`;`)
}
