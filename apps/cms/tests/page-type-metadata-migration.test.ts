import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { afterAll, describe, expect, it } from 'vitest'
import { migrations } from '../src/migrations/index.js'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-page-type-metadata-migration-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('page type metadata migration', () => {
  it('upgrades the deployed schema without changing existing pages and rolls back its columns', async () => {
    const client = createClient({ url: `file:${join(directory, 'upgrade.sqlite')}` })
    const db = drizzle(client)
    const targetIndex = migrations.findIndex((migration) => migration.name === '20261004_030000_page_type_metadata')
    expect(targetIndex).toBe(31)
    const target = migrations[targetIndex]
    const prior = migrations.slice(0, targetIndex)
    for (const [batch, migration] of prior.entries()) {
      await migration.up({ db } as never)
      await client.execute({ sql: 'INSERT INTO payload_migrations (id, name, batch) VALUES (?, ?, ?)', args: [randomUUID(), migration.name, batch] })
    }
    const pageID = randomUUID()
    await client.execute({ sql: 'INSERT INTO pages (id, title, slug, summary, template, status, blocks) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [pageID, 'Existing page', 'existing-page', 'Existing summary', 'standard', 'draft', '[]'] })
    await target!.up({ db } as never)
    const pageColumns = (await client.execute("SELECT name FROM pragma_table_info('pages')")).rows.map((row) => row.name)
    const versionColumns = (await client.execute("SELECT name FROM pragma_table_info('_pages_v')")).rows.map((row) => row.name)
    expect(pageColumns).toEqual(expect.arrayContaining(['kicker', 'lede', 'published_at', 'last_reviewed', 'job_posting']))
    expect(versionColumns).toEqual(expect.arrayContaining(['version_kicker', 'version_lede', 'version_published_at', 'version_last_reviewed', 'version_job_posting']))
    expect((await client.execute({ sql: 'SELECT title FROM pages WHERE id = ?', args: [pageID] })).rows[0]?.title).toBe('Existing page')
    await target!.down({ db } as never)
    expect((await client.execute("SELECT name FROM pragma_table_info('pages') WHERE name IN ('kicker', 'lede', 'published_at', 'last_reviewed', 'job_posting')")).rows).toHaveLength(0)
    expect((await client.execute("SELECT name FROM pragma_table_info('_pages_v') WHERE name LIKE 'version_kicker' OR name LIKE 'version_lede' OR name LIKE 'version_published_at' OR name LIKE 'version_last_reviewed' OR name LIKE 'version_job_posting'")).rows).toHaveLength(0)
    expect((await client.execute({ sql: 'SELECT title FROM pages WHERE id = ?', args: [pageID] })).rows[0]?.title).toBe('Existing page')
    await client.close()
  }, 60_000)
})
