import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`invitations_provider_subject_idx\`;`)
  await db.run(sql`ALTER TABLE \`invitations\` ADD \`provider_issuer\` text NOT NULL;`)
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_auth_transactions\` (
    \`id\` text(36) PRIMARY KEY NOT NULL,
    \`state_hash\` text NOT NULL,
    \`nonce\` text NOT NULL,
    \`verifier\` text NOT NULL,
    \`provider\` text NOT NULL,
    \`invitation_id\` text(36),
    \`expires_at\` text NOT NULL,
    \`consumed_at\` text,
    \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    FOREIGN KEY (\`invitation_id\`) REFERENCES \`invitations\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`INSERT INTO \`__new_auth_transactions\`("id", "state_hash", "nonce", "verifier", "provider", "invitation_id", "expires_at", "consumed_at", "updated_at", "created_at") SELECT "id", "state_hash", "nonce", "verifier", "provider", "invitation_id", "expires_at", "consumed_at", "updated_at", "created_at" FROM \`auth_transactions\`;`)
  await db.run(sql`DROP TABLE \`auth_transactions\`;`)
  await db.run(sql`ALTER TABLE \`__new_auth_transactions\` RENAME TO \`auth_transactions\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE UNIQUE INDEX \`auth_transactions_state_hash_idx\` ON \`auth_transactions\` (\`state_hash\`);`)
  await db.run(sql`CREATE INDEX \`auth_transactions_invitation_idx\` ON \`auth_transactions\` (\`invitation_id\`);`)
  await db.run(sql`CREATE INDEX \`auth_transactions_updated_at_idx\` ON \`auth_transactions\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`auth_transactions_created_at_idx\` ON \`auth_transactions\` (\`created_at\`);`)
  await db.run(sql`ALTER TABLE \`users\` ADD \`provider_issuer\` text;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_auth_transactions\` (
    \`id\` text(36) PRIMARY KEY NOT NULL,
    \`state_hash\` text NOT NULL,
    \`nonce\` text NOT NULL,
    \`verifier\` text NOT NULL,
    \`provider\` text NOT NULL,
    \`invitation_id\` text(36) NOT NULL,
    \`expires_at\` text NOT NULL,
    \`consumed_at\` text,
    \`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    \`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    FOREIGN KEY (\`invitation_id\`) REFERENCES \`invitations\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`INSERT INTO \`__new_auth_transactions\`("id", "state_hash", "nonce", "verifier", "provider", "invitation_id", "expires_at", "consumed_at", "updated_at", "created_at") SELECT "id", "state_hash", "nonce", "verifier", "provider", "invitation_id", "expires_at", "consumed_at", "updated_at", "created_at" FROM \`auth_transactions\`;`)
  await db.run(sql`DROP TABLE \`auth_transactions\`;`)
  await db.run(sql`ALTER TABLE \`__new_auth_transactions\` RENAME TO \`auth_transactions\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE UNIQUE INDEX \`auth_transactions_state_hash_idx\` ON \`auth_transactions\` (\`state_hash\`);`)
  await db.run(sql`CREATE INDEX \`auth_transactions_invitation_idx\` ON \`auth_transactions\` (\`invitation_id\`);`)
  await db.run(sql`CREATE INDEX \`auth_transactions_updated_at_idx\` ON \`auth_transactions\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`auth_transactions_created_at_idx\` ON \`auth_transactions\` (\`created_at\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`invitations_provider_subject_idx\` ON \`invitations\` (\`provider_subject\`);`)
  await db.run(sql`ALTER TABLE \`invitations\` DROP COLUMN \`provider_issuer\`;`)
  await db.run(sql`ALTER TABLE \`users\` DROP COLUMN \`provider_issuer\`;`)
}
