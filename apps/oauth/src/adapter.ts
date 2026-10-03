import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

type StoredRow = { payload: string; consumed_at: number | null; expires_at: number | null };
type Payload = Record<string, unknown>;

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
  PRAGMA journal_mode = WAL;`);
  return db;
}

export function createHashedAdapter(db: DatabaseSync) {
  return (model: string) => new HashedSQLiteAdapter(model, db);
}
