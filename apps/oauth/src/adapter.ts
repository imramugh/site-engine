import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

type StoredRow = { payload: string; consumed_at: number | null; expires_at: number | null };
type Payload = Record<string, unknown>;
export type GrantBinding = { userId: string; sessionId: string; clientId: string; clientName: string; resource: string; scopes: string[]; expiresAt: number };
export type ManagedGrant = GrantBinding & { managementId: string; createdAt: number; lastUsedAt?: number };
const managementID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const tokenModels = new Set(['AccessToken', 'AuthorizationCode', 'RefreshToken']);

function persistedPayload(id: string, payload: Payload): Payload {
  const stored = structuredClone(payload) as Payload;
  // oidc-provider uses jti as the opaque token or code identifier. The adapter
  // reconstructs it from the lookup key and never writes its raw value to SQLite.
  if (tokenModels.has(String(stored.kind)) || stored.jti === id) stored.jti = '__adapter_lookup_id__';
  return stored;
}

function restoredPayload(id: string, row: StoredRow): Payload {
  const payload = JSON.parse(row.payload) as Payload;
  if (payload.jti === '__adapter_lookup_id__') payload.jti = id;
  if (row.consumed_at) payload.consumed = Math.floor(row.consumed_at / 1000);
  return payload;
}

export class HashedSQLiteAdapter {
  readonly #model: string;
  readonly #db: DatabaseSync;

  constructor(model: string, db: DatabaseSync) {
    this.#model = model;
    this.#db = db;
  }

  async upsert(id: string, payload: Payload, expiresIn?: number): Promise<void> {
    const expiresAt = expiresIn === undefined ? null : Date.now() + (expiresIn * 1000);
    const uid = typeof payload.uid === 'string' ? hash(payload.uid) : null;
    const userCode = typeof payload.userCode === 'string' ? hash(payload.userCode) : null;
    const grant = typeof payload.grantId === 'string' ? hash(payload.grantId) : null;
    this.#db.prepare(`INSERT INTO oidc_records (model, id_hash, payload, expires_at, uid_hash, user_code_hash, grant_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model, id_hash) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at,
      uid_hash = excluded.uid_hash, user_code_hash = excluded.user_code_hash, grant_hash = excluded.grant_hash, consumed_at = NULL`)
      .run(this.#model, hash(id), JSON.stringify(persistedPayload(id, payload)), expiresAt, uid, userCode, grant);
  }

  async find(id: string): Promise<Payload | undefined> {
    const row = this.#db.prepare('SELECT payload, consumed_at, expires_at FROM oidc_records WHERE model = ? AND id_hash = ?').get(this.#model, hash(id)) as StoredRow | undefined;
    if (!row) return undefined;
    if (row.expires_at !== null && row.expires_at <= Date.now()) { await this.destroy(id); return undefined; }
    return restoredPayload(id, row);
  }

  async findByUid(uid: string): Promise<Payload | undefined> {
    const row = this.#db.prepare('SELECT payload, consumed_at, expires_at FROM oidc_records WHERE model = ? AND uid_hash = ?').get(this.#model, hash(uid)) as StoredRow | undefined;
    if (!row || (row.expires_at !== null && row.expires_at <= Date.now())) return undefined;
    return restoredPayload('', row);
  }

  async findByUserCode(userCode: string): Promise<Payload | undefined> {
    const row = this.#db.prepare('SELECT payload, consumed_at, expires_at FROM oidc_records WHERE model = ? AND user_code_hash = ?').get(this.#model, hash(userCode)) as StoredRow | undefined;
    if (!row || (row.expires_at !== null && row.expires_at <= Date.now())) return undefined;
    return restoredPayload('', row);
  }

  async consume(id: string): Promise<void> {
    this.#db.prepare('UPDATE oidc_records SET consumed_at = ? WHERE model = ? AND id_hash = ?').run(Date.now(), this.#model, hash(id));
  }

  async destroy(id: string): Promise<void> {
    this.#db.prepare('DELETE FROM oidc_records WHERE model = ? AND id_hash = ?').run(this.#model, hash(id));
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    this.#db.prepare('DELETE FROM oidc_records WHERE grant_hash = ?').run(hash(grantId));
  }
}

export function openOAuthDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS oidc_records (
    model TEXT NOT NULL,
    id_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    expires_at INTEGER,
    consumed_at INTEGER,
    uid_hash TEXT,
    user_code_hash TEXT,
    grant_hash TEXT,
    PRIMARY KEY (model, id_hash)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS oidc_records_grant_idx ON oidc_records(grant_hash);
  CREATE INDEX IF NOT EXISTS oidc_records_uid_idx ON oidc_records(model, uid_hash);
  CREATE TABLE IF NOT EXISTS oauth_grant_bindings (
    grant_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    scopes TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    management_id TEXT,
    client_name TEXT,
    created_at INTEGER,
    last_used_at INTEGER,
    revoked_at INTEGER
  ) STRICT;
  CREATE INDEX IF NOT EXISTS oauth_grant_bindings_session_idx ON oauth_grant_bindings(session_id);
  CREATE TABLE IF NOT EXISTS oauth_schema_migrations (version INTEGER PRIMARY KEY) STRICT;
  INSERT OR IGNORE INTO oauth_schema_migrations (version) VALUES (1);
  CREATE TABLE IF NOT EXISTS oauth_audit_events (
    id INTEGER PRIMARY KEY,
    event TEXT NOT NULL,
    grant_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  PRAGMA journal_mode = WAL;`);
  const columns = new Set((db.prepare('PRAGMA table_info(oauth_grant_bindings)').all() as Array<{ name: string }>).map((column) => column.name));
  for (const [name, declaration] of [['management_id', 'TEXT'], ['client_name', 'TEXT'], ['created_at', 'INTEGER'], ['last_used_at', 'INTEGER'], ['revoked_at', 'INTEGER']] as const) if (!columns.has(name)) db.exec(`ALTER TABLE oauth_grant_bindings ADD COLUMN ${name} ${declaration}`);
  const legacy = db.prepare('SELECT grant_hash FROM oauth_grant_bindings WHERE management_id IS NULL').all() as Array<{ grant_hash: string }>
  const backfill = db.prepare('UPDATE oauth_grant_bindings SET management_id = ?, client_name = COALESCE(client_name, ?), created_at = COALESCE(created_at, ?) WHERE grant_hash = ?')
  // The legacy schema did not retain connection time. Do not invent it from
  // the deployment time; zero is projected as an unavailable date in the UI.
  for (const row of legacy) backfill.run(randomUUID(), 'Connected assistant', 0, row.grant_hash)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS oauth_grant_bindings_management_idx ON oauth_grant_bindings(management_id); INSERT OR IGNORE INTO oauth_schema_migrations (version) VALUES (2);');
  return db;
}

export function revokeGrantFamily(db: DatabaseSync, grantId: string, event: string): void {
  const grantHash = hash(grantId)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM oidc_records WHERE grant_hash = ?').run(grantHash)
    db.prepare('UPDATE oauth_grant_bindings SET expires_at = 0, revoked_at = ? WHERE grant_hash = ?').run(Date.now(), grantHash)
    db.prepare('INSERT INTO oauth_audit_events (event, grant_hash, created_at) VALUES (?, ?, ?)').run(event, grantHash, Date.now())
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

export function storeGrantBinding(db: DatabaseSync, grantId: string, binding: GrantBinding): boolean {
  const existing = findGrantBinding(db, grantId)
  if (existing && (existing.userId !== binding.userId || existing.sessionId !== binding.sessionId || existing.clientId !== binding.clientId || existing.resource !== binding.resource)) return false
  const scopes = existing ? [...new Set([...existing.scopes, ...binding.scopes])] : binding.scopes
  const now = Date.now(); const managementId = existing?.managementId || randomUUID();
  db.prepare(`INSERT INTO oauth_grant_bindings (grant_hash, user_id, session_id, client_id, resource, scopes, expires_at, management_id, client_name, created_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(grant_hash) DO UPDATE SET user_id = excluded.user_id, session_id = excluded.session_id, client_id = excluded.client_id, resource = excluded.resource, scopes = excluded.scopes, expires_at = excluded.expires_at, client_name = excluded.client_name, revoked_at = NULL`)
    .run(hash(grantId), binding.userId, binding.sessionId, binding.clientId, binding.resource, JSON.stringify(scopes), binding.expiresAt, managementId, binding.clientName, existing?.createdAt ?? now)
  return true
}

export function findGrantBinding(db: DatabaseSync, grantId: string): ManagedGrant | undefined {
  const row = db.prepare('SELECT user_id, session_id, client_id, client_name, resource, scopes, expires_at, management_id, created_at, last_used_at FROM oauth_grant_bindings WHERE grant_hash = ? AND revoked_at IS NULL').get(hash(grantId)) as { user_id: string; session_id: string; client_id: string; client_name: string | null; resource: string; scopes: string; expires_at: number; management_id: string | null; created_at: number | null; last_used_at: number | null } | undefined
  if (!row || row.expires_at <= Date.now()) return undefined
  try {
    const scopes = JSON.parse(row.scopes) as unknown
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) return undefined
    return { userId: row.user_id, sessionId: row.session_id, clientId: row.client_id, clientName: row.client_name ?? 'Connected assistant', resource: row.resource, scopes, expiresAt: row.expires_at, managementId: row.management_id ?? '', createdAt: row.created_at ?? 0, ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}) }
  } catch { return undefined }
}

export function createHashedAdapter(db: DatabaseSync) {
  return (model: string) => new HashedSQLiteAdapter(model, db);
}

function managed(row: { user_id: string; session_id: string; client_id: string; client_name: string | null; resource: string; scopes: string; expires_at: number; management_id: string; created_at: number; last_used_at: number | null }): ManagedGrant | undefined {
  try {
    const parsed = JSON.parse(row.scopes) as unknown
    if (!managementID.test(row.management_id) || !Array.isArray(parsed) || !parsed.every((scope) => typeof scope === 'string')) return undefined
    return { managementId: row.management_id, userId: row.user_id, sessionId: row.session_id, clientId: row.client_id, clientName: row.client_name ?? 'Connected assistant', resource: row.resource, scopes: parsed, expiresAt: row.expires_at, createdAt: row.created_at, ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}) }
  } catch { return undefined }
}

export function listManagedGrants(db: DatabaseSync, userId?: string, now = Date.now()): ManagedGrant[] {
  const rows = (userId
    ? db.prepare('SELECT user_id, session_id, client_id, client_name, resource, scopes, expires_at, management_id, created_at, last_used_at FROM oauth_grant_bindings WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 500').all(userId, now)
    : db.prepare('SELECT user_id, session_id, client_id, client_name, resource, scopes, expires_at, management_id, created_at, last_used_at FROM oauth_grant_bindings WHERE revoked_at IS NULL AND expires_at > ? ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 500').all(now)) as Parameters<typeof managed>[0][]
  return rows.map(managed).filter((item): item is ManagedGrant => Boolean(item))
}

export function touchManagedGrant(db: DatabaseSync, grantId: string, now = Date.now()): void {
  db.prepare('UPDATE oauth_grant_bindings SET last_used_at = ? WHERE grant_hash = ? AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at < ?)').run(now, hash(grantId), now - 60_000)
}

export function revokeManagedGrant(db: DatabaseSync, managementId: string, userId?: string): boolean {
  if (!managementID.test(managementId)) return false
  const row = db.prepare(`SELECT grant_hash FROM oauth_grant_bindings WHERE management_id = ? AND revoked_at IS NULL${userId ? ' AND user_id = ?' : ''}`).get(...(userId ? [managementId, userId] : [managementId])) as { grant_hash: string } | undefined
  if (!row) return false
  const now = Date.now(); db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM oidc_records WHERE grant_hash = ?').run(row.grant_hash)
    db.prepare('UPDATE oauth_grant_bindings SET expires_at = 0, revoked_at = ? WHERE grant_hash = ?').run(now, row.grant_hash)
    db.prepare('INSERT INTO oauth_audit_events (event, grant_hash, created_at) VALUES (?, ?, ?)').run('oauth.grant_management_revoked', row.grant_hash, now)
    db.exec('COMMIT'); return true
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
