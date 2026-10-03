import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createLocalReq, getPayload } from 'payload'
import type { MigrateUpArgs } from '@payloadcms/db-sqlite'
import { up, down } from '../src/migrations/20261003_042858_invitation_required_subject'

const directory = mkdtempSync(join(tmpdir(), 'engine-invitation-upgrade-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-only-invitation-migration-payload-secret'
const { default: config } = await import('../payload.config')
let payload: Awaited<ReturnType<typeof getPayload>>
type Adapter = { sessions: Record<string, { db: MigrateUpArgs['db'] }>; client: { execute: (sql: string) => Promise<{ rows: unknown[] }> } }

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

async function migrate(operation: typeof up) {
  const transactionID = await payload.db.beginTransaction()
  if (!transactionID) throw new Error('Expected a real migration transaction')
  const req = await createLocalReq({ req: { transactionID } }, payload)
  const db = (payload.db as unknown as Adapter).sessions[String(transactionID)].db
  try { await operation({ db, payload, req }); await payload.db.commitTransaction(transactionID) }
  catch (error) { await payload.db.rollbackTransaction(transactionID); throw error }
}

it('ENG-007 upgrade preserves legacy invitation bindings, roles and active sign-in references', async () => {
  const invitation = await payload.create({ collection: 'invitations', data: { email: 'legacy@example.test', provider: 'google', providerIssuer: 'https://issuer.example.test', providerSubject: 'legacy-subject', roles: ['editor', 'approver'], tokenHash: 'synthetic-invite-hash', expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  const transaction = await payload.create({ collection: 'auth-transactions', data: { provider: 'google', invitation: invitation.id, stateHash: 'synthetic-state-hash', nonce: 'synthetic-nonce', verifier: 'synthetic-verifier', expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  // Recreate the immediately preceding schema while retaining real relational rows.
  await migrate(down)
  await migrate(up)
  const upgraded = await payload.findByID({ collection: 'invitations', id: invitation.id, overrideAccess: true })
  expect(upgraded.requiredSubject).toBe('legacy-subject')
  expect(upgraded.roles).toEqual(['editor', 'approver'])
  const pending = await payload.findByID({ collection: 'auth-transactions', id: transaction.id, depth: 0, overrideAccess: true })
  expect(pending.invitation).toBe(invitation.id)
  const client = (payload.db as unknown as Adapter).client
  expect((await client.execute('PRAGMA foreign_key_check')).rows).toEqual([])
})
