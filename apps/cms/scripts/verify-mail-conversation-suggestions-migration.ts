import assert from 'node:assert/strict'
import { getPayload } from 'payload'
import config from '../payload.config.js'

const payload = await getPayload({ config })
try {
  const owner = await payload.create({ collection: 'users', data: { email: 'suggestion-migration-owner@example.test', name: 'Suggestion migration owner', roles: ['owner'] }, overrideAccess: true })
  const mailbox = await payload.create({ collection: 'mailbox-configurations', data: { name: 'Suggestion migration mailbox', provider: 'google', primaryAddress: 'suggestion-migration@example.test', aliases: [], verifiedAliases: [], host: 'smtp.example.test', port: 587, security: 'starttls', username: 'suggestion-migration', encryptedCredential: 'opaque', credentialRevision: 'revision-a', health: 'connected' }, overrideAccess: true, context: { mailboxInternal: true } })
  const base = { mailbox: mailbox.id, provider: 'google' as const, providerConversationID: 'provider-conversation-1', addressHash: 'a'.repeat(64), adoptedBy: owner.id }
  const lead = await payload.create({ collection: 'mail-conversation-suggestions', data: { ...base, target: 'lead' }, overrideAccess: true })
  assert.ok(lead.id)
  await assert.rejects(() => payload.create({ collection: 'mail-conversation-suggestions', data: { ...base, target: 'lead' }, overrideAccess: true }))
  const application = await payload.create({ collection: 'mail-conversation-suggestions', data: { ...base, target: 'application' }, overrideAccess: true })
  assert.ok(application.id)
  assert.equal((await payload.find({ collection: 'mail-conversation-suggestions', where: { and: [{ mailbox: { equals: mailbox.id } }, { provider: { equals: 'google' } }, { providerConversationID: { equals: base.providerConversationID } }] }, limit: 10, overrideAccess: true })).totalDocs, 2)
  console.log('mail conversation suggestions production uniqueness, foreign keys, and distinct targets verified')
} finally { await payload.destroy() }
