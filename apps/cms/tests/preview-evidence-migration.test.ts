import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { migrations } from '../src/migrations/index.js'

test('adds screenshot evidence after the prior schema and preserves legacy reviews through rollback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'preview-evidence-migration-'))
  const client = createClient({ url: `file:${join(directory, 'cms.sqlite')}` })
  const db = drizzle(client)
  try {
    const index = migrations.findIndex(item => item.name === '20261009_121000_preview_evidence_manifest')
    expect(index).toBeGreaterThan(migrations.findIndex(item => item.name === '20261007_010000_local_staff_auth'))
    for (const migration of migrations.slice(0, index)) await migration.up({ db } as never)
    await client.execute("INSERT INTO change_sets (id, name) VALUES ('review', 'Prior review')")
    await client.execute({
      sql: `INSERT INTO preview_render_jobs (id, change_set_id, review_revision, change_hash, included_change_keys,
        live_manifest, proposed_manifest, live_manifest_hash, proposed_manifest_hash, version_pins, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['job', 'review', 1, 'a'.repeat(64), '[]', '{"pages":[]}', '{"pages":[]}', 'b'.repeat(64), 'c'.repeat(64), '{}', 'completed'],
    })
    const prior = (await client.execute('SELECT * FROM preview_render_jobs')).rows[0]!
    const migration = migrations[index]!
    await migration.up({ db } as never)
    expect((await client.execute('SELECT * FROM preview_render_jobs')).rows).toEqual([{ ...prior, evidence_manifest: null }])
    await client.execute({ sql: 'UPDATE preview_render_jobs SET evidence_manifest = ? WHERE id = ?', args: ['{"version":1}', 'job'] })
    await migration.down({ db } as never)
    expect((await client.execute('SELECT * FROM preview_render_jobs')).rows).toEqual([prior])
    await migration.up({ db } as never)
    expect((await client.execute('SELECT evidence_manifest FROM preview_render_jobs')).rows).toEqual([{ evidence_manifest: null }])
  } finally {
    client.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
