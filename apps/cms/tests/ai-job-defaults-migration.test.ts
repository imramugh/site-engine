import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { afterAll, expect, test } from 'vitest'
import { migrations } from '../src/migrations/index.js'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-ai-defaults-migration-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test('upgrades the prior production schema without push and preserves durable jobs', async () => {
  const client = createClient({ url: `file:${join(directory, 'prior.sqlite')}` }); const db = drizzle(client)
  const index = migrations.findIndex(item => item.name === '20261006_010000_ai_job_defaults'); expect(index).toBeGreaterThan(0)
  for (const [batch, migration] of migrations.slice(0, index).entries()) { await migration.up({ db } as never); await client.execute({ sql: 'INSERT INTO payload_migrations (id, name, batch) VALUES (?, ?, ?)', args: [randomUUID(), migration.name, batch] }) }
  const jobID = '11111111-1111-4111-8111-111111111111'; const actor = '22222222-2222-4222-8222-222222222222'
  await client.execute({ sql: 'INSERT INTO users (id, email, name, updated_at, created_at) VALUES (?, ?, ?, ?, ?)', args: [actor, 'migration@example.test', 'Migration', '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z'] })
  await client.execute({ sql: 'INSERT INTO configured_ai_jobs (id, actor_id, idempotency_key, request_digest, input, provider, max_output_tokens, configuration_snapshot, state, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [jobID, actor, 'preserved-job', 'a'.repeat(64), 'preserved input', 'openai', 12, '[]', 'queued', '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z'] })
  await migrations[index]!.up({ db } as never)
  expect((await client.execute({ sql: 'SELECT input, image_data_url FROM configured_ai_jobs WHERE id = ?', args: [jobID] })).rows).toEqual([{ input: 'preserved input', image_data_url: null }])
  expect((await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_job_defaults'")).rows).toHaveLength(1)
  expect((await client.execute("SELECT name FROM pragma_table_info('ai_job_defaults') WHERE name = 'model'")).rows).toHaveLength(1)
  await client.execute({ sql: 'INSERT INTO ai_job_defaults (id, job_type, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', args: [randomUUID(), 'summary', 'openai', 'reviewed-model', '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z'] })
  expect((await client.execute("SELECT provider, model FROM ai_job_defaults WHERE job_type = 'summary'")).rows).toEqual([{ provider: 'openai', model: 'reviewed-model' }])
  expect((await client.execute('SELECT count(*) AS count FROM payload_migrations')).rows[0]?.count).toBe(index)
  await client.close()
}, 60_000)
