import { createClient, type Client } from '@libsql/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPayload } from 'payload'
import { isRetryableSQLiteError } from '../src/sqlite'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-writer-backpressure-'))
const dbPath = join(directory, 'cms.sqlite')
const tokenFile = join(directory, 'bootstrap-token')
process.env.DATABASE_URI = `file:${dbPath}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-writer-backpressure'
writeFileSync(tokenFile, 'test-only-bootstrap-token')
process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE = tokenFile

const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>

const close = (client: Client) => client.close()

beforeAll(async () => {
  payload = await getPayload({ config })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  rmSync(directory, { recursive: true, force: true })
})

describe('SQLite writer backpressure (ENG-036)', () => {
  it('configures Payload with a finite five-second busy timeout', async () => {
    const client = (payload.db as unknown as { client: { execute: (statement: string) => Promise<{ rows: Record<string, unknown>[] }> } }).client
    const result = await client.execute('PRAGMA busy_timeout')
    expect(result.rows[0]?.timeout).toBe(5_000)
  })

  it('bounds contention between two independent libsql connections and lets one retry commit once', async () => {
    const writer = createClient({ url: `file:${dbPath}` })
    const contender = createClient({ url: `file:${dbPath}` })
    try {
      await writer.execute('PRAGMA journal_mode = WAL')
      await writer.execute('CREATE TABLE writer_backpressure_records (value TEXT PRIMARY KEY)')
      // The test timeout is intentionally short so it proves a deadline without
      // waiting for the production five-second setting.
      await contender.execute('PRAGMA busy_timeout = 150')

      const lock = await writer.transaction('write')
      await lock.execute("INSERT INTO writer_backpressure_records VALUES ('holder')")

      const startedAt = performance.now()
      let failure: unknown
      try {
        await contender.execute("INSERT INTO writer_backpressure_records VALUES ('contender')")
      } catch (error) {
        failure = error
      }
      const elapsed = performance.now() - startedAt
      expect(failure).toBeDefined()
      expect(isRetryableSQLiteError(failure)).toBe(true)
      expect(elapsed).toBeGreaterThanOrEqual(75)
      // This is a deadline check, not a benchmark. A generous ceiling catches
      // an accidental unbounded wait while allowing loaded CI hosts.
      expect(elapsed).toBeLessThan(5_000)

      await lock.commit()
      await contender.execute("INSERT INTO writer_backpressure_records VALUES ('contender')")
      expect((await contender.execute('SELECT value FROM writer_backpressure_records ORDER BY value')).rows).toEqual([
        { value: 'contender' }, { value: 'holder' },
      ])
    } finally {
      close(contender)
      close(writer)
    }
  })

  it('rolls back an approval, durable outbox, and audit change set together after a later failure', async () => {
    const client = createClient({ url: `file:${join(directory, 'atomic.sqlite')}` })
    try {
      await client.execute('PRAGMA foreign_keys = ON')
      await client.execute('CREATE TABLE writer_change_sets (id TEXT PRIMARY KEY)')
      await client.execute('CREATE TABLE writer_publish_outbox (id TEXT PRIMARY KEY, change_set_id TEXT NOT NULL REFERENCES writer_change_sets(id))')
      await client.execute("CREATE TABLE writer_audit (id TEXT PRIMARY KEY, change_set_id TEXT NOT NULL REFERENCES writer_change_sets(id), event TEXT NOT NULL CHECK(event = 'approved'))")

      const failed = await client.transaction('write')
      try {
        await failed.execute("INSERT INTO writer_change_sets VALUES ('change-1')")
        await failed.execute("INSERT INTO writer_publish_outbox VALUES ('outbox-1', 'change-1')")
        await failed.execute("INSERT INTO writer_audit VALUES ('audit-1', 'change-1', 'invalid-event')")
        throw new Error('Expected audit CHECK failure')
      } catch (error) {
        expect(String(error)).toMatch(/CHECK constraint failed/)
        await failed.rollback()
      }

      for (const table of ['writer_change_sets', 'writer_publish_outbox', 'writer_audit']) {
        expect((await client.execute(`SELECT * FROM ${table}`)).rows).toEqual([])
      }

      const retry = await client.transaction('write')
      await retry.execute("INSERT INTO writer_change_sets VALUES ('change-1')")
      await retry.execute("INSERT INTO writer_publish_outbox VALUES ('outbox-1', 'change-1')")
      await retry.execute("INSERT INTO writer_audit VALUES ('audit-1', 'change-1', 'approved')")
      await retry.commit()
      expect((await client.execute('SELECT id FROM writer_publish_outbox')).rows).toEqual([{ id: 'outbox-1' }])
    } finally {
      close(client)
    }
  })
})
