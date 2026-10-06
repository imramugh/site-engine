import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listManagedGrants, openOAuthDatabase, revokeManagedGrant, storeGrantBinding, touchManagedGrant } from '../src/adapter.js'

const directories: string[] = []
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }) })
const database = () => { const directory = mkdtempSync(join(tmpdir(), 'oauth-grants-')); directories.push(directory); return join(directory, 'oauth.sqlite') }

describe('OAuth grant management metadata', () => {
  it('upgrades legacy hashed bindings without exposing a grant key and preserves revocation', () => {
    const path = database(); const legacy = new DatabaseSync(path)
    legacy.exec(`CREATE TABLE oauth_grant_bindings (grant_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,session_id TEXT NOT NULL,client_id TEXT NOT NULL,resource TEXT NOT NULL,scopes TEXT NOT NULL,expires_at INTEGER NOT NULL) STRICT; CREATE TABLE oauth_schema_migrations(version INTEGER PRIMARY KEY) STRICT; INSERT INTO oauth_schema_migrations VALUES(1); CREATE TABLE oauth_audit_events(id INTEGER PRIMARY KEY,event TEXT NOT NULL,grant_hash TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT; CREATE TABLE oidc_records(model TEXT NOT NULL,id_hash TEXT NOT NULL,payload TEXT NOT NULL,expires_at INTEGER,consumed_at INTEGER,uid_hash TEXT,user_code_hash TEXT,grant_hash TEXT,PRIMARY KEY(model,id_hash)) STRICT;`)
    legacy.prepare('INSERT INTO oauth_grant_bindings VALUES(?,?,?,?,?,?,?)').run('hashed-only-family', 'legacy-user', 'legacy-session', 'legacy-client', 'https://cms.test/mcp', '["mcp:content:read"]', Date.now() + 60_000); legacy.close()
    const db = openOAuthDatabase(path); expect(listManagedGrants(db, 'legacy-user')).toEqual([])
    expect((db.prepare('SELECT version FROM oauth_schema_migrations ORDER BY version').all() as Array<{version:number}>).map(row => row.version)).toEqual([1, 2]); db.close()
  })

  it('lists active grants by owner or person, records usage, and never returns session IDs to the HTTP projection', () => {
    const db = openOAuthDatabase(database()); const now = Date.now()
    expect(storeGrantBinding(db, 'raw-grant-id', { userId: 'user-a', sessionId: 'session-secret', clientId: 'client-a', clientName: 'Claude Desktop', resource: 'https://cms.test/mcp', scopes: ['mcp:content:read'], expiresAt: now + 60_000 })).toBe(true)
    const grantHash = (db.prepare('SELECT grant_hash FROM oauth_grant_bindings').get() as { grant_hash: string }).grant_hash; db.prepare('INSERT INTO oidc_records (model,id_hash,payload,expires_at,grant_hash) VALUES(?,?,?,?,?)').run('AccessToken', 'active-token', '{}', now + 60_000, grantHash)
    touchManagedGrant(db, 'raw-grant-id', now + 1_000); const listed = listManagedGrants(db, 'user-a')
    expect(listed).toHaveLength(1); expect(listed[0]).toMatchObject({ clientName: 'Claude Desktop', lastUsedAt: now + 1_000 }); expect(listManagedGrants(db, 'user-b')).toEqual([]); db.close()
  })

  it('recovers migrated client names, excludes expired families, and isolates revocation', () => {
    const db = openOAuthDatabase(database()); const now = Date.now()
    for (const [grant, client] of [['grant-a', 'client-a'], ['grant-b', 'client-b']] as const) {
      storeGrantBinding(db, grant, { userId: 'user-a', sessionId: `${grant}-session`, clientId: client, clientName: 'Connected assistant', resource: 'https://cms.test/mcp', scopes: ['mcp:content:read'], expiresAt: now + 60_000 })
      const grantHash = (db.prepare('SELECT grant_hash FROM oauth_grant_bindings WHERE client_id = ?').get(client) as { grant_hash: string }).grant_hash
      db.prepare('INSERT INTO oidc_records (model,id_hash,payload,expires_at,grant_hash) VALUES(?,?,?,?,?)').run('Grant', `${grant}-record`, '{}', now + 60_000, grantHash)
      db.prepare('INSERT INTO oidc_records (model,id_hash,payload,expires_at) VALUES(?,?,?,NULL)').run('Client', createHash('sha256').update(client).digest('base64url'), JSON.stringify({ client_name: client === 'client-a' ? 'Recovered Claude' : 'Other assistant' }))
    }
    const listed = listManagedGrants(db, 'user-a'); expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ clientName: 'Recovered Claude' }), expect.objectContaining({ clientName: 'Other assistant' })]))
    expect(revokeManagedGrant(db, listed.find(item => item.clientName === 'Recovered Claude')!.managementId, 'user-a')).toBe(true); expect(listManagedGrants(db, 'user-a')).toEqual([expect.objectContaining({ clientName: 'Other assistant' })])
    db.close()
  })
})
