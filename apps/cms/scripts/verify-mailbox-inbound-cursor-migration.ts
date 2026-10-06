import assert from 'node:assert/strict'
import { getPayload } from 'payload'
import { sql } from '@payloadcms/db-sqlite'
import config from '../payload.config.js'
import { down, up } from '../src/migrations/20261006_003000_mailbox_inbound_cursor.js'

const payload = await getPayload({ config })
try {
  const mailbox = await payload.create({ collection: 'mailbox-configurations', data: { name: 'Cursor mailbox', provider: 'smtp', primaryAddress: 'cursor@example.test', aliases: [], verifiedAliases: [], host: 'smtp.example.test', port: 587, security: 'starttls', username: 'cursor', encryptedCredential: 'opaque', credentialRevision: 'revision-a', health: 'connected', inboundCursor: 'cursor-a', inboundCursorRevision: 'revision-a' }, overrideAccess: true, context: { mailboxInternal: true } }) as any
  assert.equal(mailbox.inboundCursor, 'cursor-a')
  const args = { db: payload.db.drizzle, payload, req: {} } as never
  await down(args)
  const preserved = await payload.db.drizzle.all(sql`SELECT id FROM mailbox_configurations WHERE id = ${mailbox.id}`)
  assert.equal(preserved.length, 1)
  await up(args)
  const after = await (payload as any).update({ collection: 'mailbox-configurations', id: mailbox.id, data: { inboundCursor: 'cursor-b', inboundCursorRevision: 'revision-a' }, overrideAccess: true, context: { mailboxInternal: true } })
  assert.equal(after.inboundCursor, 'cursor-b')
  console.log('mailbox inbound cursor production CRUD and down/up preservation verified')
} finally { await payload.destroy() }
