import assert from 'node:assert/strict'
import { getPayload } from 'payload'
import config from '../payload.config.js'
import { down, up } from '../src/migrations/20261006_002000_mailbox_oauth.js'

const payload = await getPayload({ config })
try {
  const owner = await payload.create({ collection: 'users', data: { email: 'oauth-migration-owner@example.test', name: 'Owner', roles: ['owner'] }, overrideAccess: true })
  const mailbox = await payload.create({ collection: 'mailbox-configurations', data: { name: 'Existing SMTP', provider: 'smtp', primaryAddress: 'existing@example.test', aliases: [], verifiedAliases: [], host: 'smtp.example.test', port: 587, security: 'starttls', username: 'existing', encryptedCredential: 'opaque', credentialRevision: 'existing', health: 'connected' }, overrideAccess: true, context: { mailboxInternal: true } })
  const transaction = await (payload as any).create({ collection: 'mailbox-oauth-transactions', data: { provider: 'microsoft', stateHash: 'state-hash', sessionHash: 'session-hash', verifier: 'encrypted-verifier', owner: owner.id, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true, context: { mailboxInternal: true } })
  assert.ok(transaction.createdAt && transaction.updatedAt)
  const lock = await payload.create({ collection: 'payload-locked-documents', data: { document: { relationTo: 'mailbox-oauth-transactions', value: transaction.id }, user: { relationTo: 'users', value: owner.id } }, overrideAccess: true })
  assert.ok(lock.id)
  await payload.delete({ collection: 'payload-locked-documents', id: lock.id, overrideAccess: true })
  await (payload as any).delete({ collection: 'mailbox-oauth-transactions', id: transaction.id, overrideAccess: true, context: { mailboxInternal: true } })
  const args = { db: payload.db.drizzle, payload, req: {} } as never
  await down(args)
  assert.equal((await payload.findByID({ collection: 'users', id: owner.id, overrideAccess: true })).id, owner.id)
  assert.equal((await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true })).id, mailbox.id)
  await up(args)
  const after = await (payload as any).create({ collection: 'mailbox-oauth-transactions', data: { provider: 'google', stateHash: 'state-hash-after', sessionHash: 'session-hash-after', verifier: 'encrypted-verifier', owner: owner.id, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true, context: { mailboxInternal: true } })
  assert.ok(after.id)
  console.log('mailbox OAuth production CRUD, lock relation, and down/up preservation verified')
} finally { await payload.destroy() }
