import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createLocalReq, getPayload } from 'payload'
import type { MigrateUpArgs } from '@payloadcms/db-sqlite'
import { up, down } from '../src/migrations/20261005_133859'

const directory = mkdtempSync(join(tmpdir(), 'engine-notification-upgrade-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-only-notification-migration-secret'
const { default: config } = await import('../payload.config')
let payload: Awaited<ReturnType<typeof getPayload>>
type Adapter = { sessions: Record<string, { db: MigrateUpArgs['db'] }>; client: { execute: (sql: string) => Promise<{ rows: unknown[] }> } }
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })
async function migrate(operation: typeof up) { const transactionID = await payload.db.beginTransaction(); if (!transactionID) throw new Error('Expected migration transaction'); const req = await createLocalReq({ req: { transactionID } }, payload); const db = (payload.db as unknown as Adapter).sessions[String(transactionID)].db; try { await operation({ db, payload, req }); await payload.db.commitTransaction(transactionID) } catch (error) { await payload.db.rollbackTransaction(transactionID); throw error } }

it('upgrades legacy queued lead intents without losing their state or inquiry binding', async () => {
  const inquiry = await payload.create({ collection: 'inquiries', data: { email: 'migration@example.test', message: 'Migration fixture', topic: 'project', sourcePage: '/contact', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'migration-inquiry-key-1234', stage: 'new', urgent: false }, overrideAccess: true })
  const event = await payload.create({ collection: 'notification-outbox', data: { inquiry: inquiry.id, kind: 'new-lead', idempotencyKey: 'migration-event-key', state: 'queued', payload: { inquiry: inquiry.id }, recipientRules: ['owner', 'sales'], recipients: [], channels: ['email'], sourceType: 'inquiry', sourceID: inquiry.id, availableAt: new Date().toISOString() }, overrideAccess: true })
  await migrate(down)
  await migrate(up)
  const upgraded = await payload.findByID({ collection: 'notification-outbox', id: event.id, depth: 0, overrideAccess: true })
  expect(upgraded).toMatchObject({ inquiry: inquiry.id, kind: 'new-lead', state: 'queued', recipientRules: ['owner', 'sales'], recipients: [], channels: ['email'], sourceType: 'inquiry', sourceID: inquiry.id })
  const client = (payload.db as unknown as Adapter).client
  expect((await client.execute('PRAGMA foreign_key_check')).rows).toEqual([])
})
