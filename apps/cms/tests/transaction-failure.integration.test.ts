import { createClient } from '@libsql/client'
import { sql } from '@payloadcms/db-sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { getPayload } from 'payload'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-transaction-failure-'))
const dbPath = join(directory, 'cms.sqlite')
const tokenFile = join(directory, 'bootstrap-token')
process.env.DATABASE_URI = `file:${dbPath}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-payload'
writeFileSync(tokenFile, 'test-only-bootstrap-token')
process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE = tokenFile

const { default: config } = await import('../payload.config.js')
type SQLiteTransaction = { run: (statement: ReturnType<typeof sql.raw>) => Promise<unknown> }
type SQLiteAdapter = {
  client: { execute: (statement: string) => Promise<{ rows: Record<string, unknown>[] }> }
  sessions: Record<string, { db: SQLiteTransaction }>
}
let payload: Awaited<ReturnType<typeof getPayload>>

function transaction(id: string | number): SQLiteTransaction {
  const session = (payload.db as unknown as SQLiteAdapter).sessions[String(id)]
  if (!session) throw new Error('Expected Payload to retain the active SQLite transaction.')
  return session.db
}

beforeAll(async () => {
  payload = await getPayload({ config })
  const client = (payload.db as unknown as SQLiteAdapter).client
  await client.execute('CREATE TABLE transaction_failure_parent (id INTEGER PRIMARY KEY)')
  await client.execute('CREATE TABLE transaction_failure_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES transaction_failure_parent(id) DEFERRABLE INITIALLY DEFERRED)')
})

afterAll(async () => {
  await payload?.destroy()
  rmSync(directory, { recursive: true, force: true })
})

describe('patched Payload SQLite transaction failures', () => {
  it('uses libsql 0.18 both directly and through the Payload SQLite adapter', async () => {
    const directEntry = realpathSync(fileURLToPath(import.meta.resolve('@libsql/client')))
    const adapterEntry = realpathSync(fileURLToPath(import.meta.resolve('@payloadcms/db-sqlite')))
    const adapterClient = realpathSync(createRequire(pathToFileURL(adapterEntry)).resolve('@libsql/client'))
    expect(directEntry).toContain('@libsql+client@0.18.0')
    expect(adapterClient).toContain('@libsql+client@0.18.0')
  })

  it('recovers a raw libsql connection after a competing failed BEGIN', async () => {
    const rawDirectory = mkdtempSync(join(tmpdir(), 'site-engine-libsql-'))
    const raw = createClient({ url: `file:${join(rawDirectory, 'repro.sqlite')}` })
    try {
      await raw.execute('PRAGMA journal_mode=WAL')
      await raw.execute('CREATE TABLE records (value INTEGER)')
      const first = await raw.transaction()
      await first.execute('INSERT INTO records VALUES (1)')
      await expect(raw.transaction()).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
      await first.commit()
      const second = await raw.transaction()
      await second.execute('INSERT INTO records VALUES (2)')
      await expect(second.commit()).resolves.toBeUndefined()
      expect((await raw.execute('SELECT value FROM records ORDER BY value')).rows).toEqual([{ value: 1 }, { value: 2 }])
    } finally {
      raw.close()
      rmSync(rawDirectory, { recursive: true, force: true })
    }
  })

  it('treats the intentional rollback abort as completion', async () => {
    const id = await payload.db.beginTransaction()
    expect(id).toEqual(expect.any(String))
    await expect(payload.db.rollbackTransaction(id!)).resolves.toBeUndefined()
  })

  it('propagates an actual deferred-constraint COMMIT failure and rolls its work back', async () => {
    const id = await payload.db.beginTransaction()
    expect(id).toEqual(expect.any(String))
    await transaction(id!).run(sql.raw('INSERT INTO transaction_failure_child (id, parent_id) VALUES (1, 404)'))
    await expect(payload.db.commitTransaction(id!)).rejects.toThrow(/FOREIGN KEY constraint failed/)
    const client = (payload.db as unknown as SQLiteAdapter).client
    expect((await client.execute('SELECT * FROM transaction_failure_child')).rows).toEqual([])
  })

  it('commits an ordinary transaction after a failed transaction', async () => {
    const id = await payload.db.beginTransaction()
    expect(id).toEqual(expect.any(String))
    const db = transaction(id!)
    await db.run(sql.raw('INSERT INTO transaction_failure_parent (id) VALUES (2)'))
    await db.run(sql.raw('INSERT INTO transaction_failure_child (id, parent_id) VALUES (2, 2)'))
    await expect(payload.db.commitTransaction(id!)).resolves.toBeUndefined()
    const client = (payload.db as unknown as SQLiteAdapter).client
    expect((await client.execute('SELECT id, parent_id FROM transaction_failure_child')).rows).toEqual([{ id: 2, parent_id: 2 }])
  })
})
