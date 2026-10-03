import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

type StoredRow = { payload: string; consumed_at: number | null; expires_at: number | null };
type Payload = Record<string, unknown>;
export type GrantBinding = { userId: string; sessionId: string; clientId: string; resource: string; scopes: string[]; expiresAt: number };

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
    expires_at INTEGER NOT NULL
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
  return db;
}

export function revokeGrantFamily(db: DatabaseSync, grantId: string, event: string): void {
  const grantHash = hash(grantId)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM oidc_records WHERE grant_hash = ?').run(grantHash)
    db.prepare('UPDATE oauth_grant_bindings SET expires_at = 0 WHERE grant_hash = ?').run(grantHash)
    db.prepare('INSERT INTO oauth_audit_events (event, grant_hash, created_at) VALUES (?, ?, ?)').run(event, grantHash, Date.now())
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

export function storeGrantBinding(db: DatabaseSync, grantId: string, binding: GrantBinding): boolean {
  const existing = findGrantBinding(db, grantId)
  if (existing && (existing.userId !== binding.userId || existing.sessionId !== binding.sessionId || existing.clientId !== binding.clientId || existing.resource !== binding.resource)) return false
  const scopes = existing ? [...new Set([...existing.scopes, ...binding.scopes])] : binding.scopes
  db.prepare(`INSERT INTO oauth_grant_bindings (grant_hash, user_id, session_id, client_id, resource, scopes, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(grant_hash) DO UPDATE SET user_id = excluded.user_id, session_id = excluded.session_id, client_id = excluded.client_id, resource = excluded.resource, scopes = excluded.scopes, expires_at = excluded.expires_at`)
    .run(hash(grantId), binding.userId, binding.sessionId, binding.clientId, binding.resource, JSON.stringify(scopes), binding.expiresAt)
  return true
}

export function findGrantBinding(db: DatabaseSync, grantId: string): GrantBinding | undefined {
  const row = db.prepare('SELECT user_id, session_id, client_id, resource, scopes, expires_at FROM oauth_grant_bindings WHERE grant_hash = ?').get(hash(grantId)) as { user_id: string; session_id: string; client_id: string; resource: string; scopes: string; expires_at: number } | undefined
  if (!row || row.expires_at <= Date.now()) return undefined
  try {
    const scopes = JSON.parse(row.scopes) as unknown
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) return undefined
    return { userId: row.user_id, sessionId: row.session_id, clientId: row.client_id, resource: row.resource, scopes, expiresAt: row.expires_at }
  } catch { return undefined }
}

export function createHashedAdapter(db: DatabaseSync) {
  return (model: string) => new HashedSQLiteAdapter(model, db);
}
