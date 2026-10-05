import assert from 'node:assert/strict'
import { getPayload } from 'payload'
import config from '../payload.config.js'

const payload = await getPayload({ config })
try {
  const owner = await payload.create({ collection: 'users', data: { email: 'probe-owner@example.test', name: 'Probe owner', roles: ['owner'] }, overrideAccess: true })
  const lead = await payload.create({ collection: 'inquiries', data: { email: 'probe-lead@example.test', message: 'probe', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: `probe-${crypto.randomUUID()}`, stage: 'new' }, overrideAccess: true })
  const app = await payload.create({ collection: 'applications', data: { name: 'Probe', email: 'probe-app@example.test', coverLetter: 'probe', consent: true, jobId: crypto.randomUUID(), resumeKey: 'probe', idempotencyKey: crypto.randomUUID(), status: 'new' }, overrideAccess: true })
  const mailbox = await payload.create({ collection: 'mailbox-configurations', data: { name: 'Probe', provider: 'smtp', primaryAddress: 'probe@example.test', aliases: [], verifiedAliases: [], host: 'smtp.example.test', port: 587, security: 'starttls', username: 'probe', encryptedCredential: 'probe', credentialRevision: 'probe', health: 'connected' }, overrideAccess: true, context: { mailboxInternal: true } })
  for (const [target, id] of [['lead', lead.id], ['application', app.id]] as const) {
    const thread = await payload.create({ collection: 'mail-threads', data: { [target]: id, mailbox: mailbox.id, provider: 'smtp', providerConversationID: `probe-${target}` }, overrideAccess: true })
    const message = await payload.create({ collection: 'mail-thread-messages', data: { thread: thread.id, mailbox: mailbox.id, [target]: id, providerMessageID: `probe-message-${target}`, direction: 'inbound', sender: 'visitor@example.test', recipient: 'probe@example.test', subject: 'probe', body: 'probe', receivedAt: new Date().toISOString() }, overrideAccess: true })
    assert.equal((await payload.findByID({ collection: 'mail-thread-messages', id: message.id, overrideAccess: true })).id, message.id)
    const lock = await payload.create({ collection: 'payload-locked-documents', data: { document: { relationTo: 'mail-threads', value: thread.id }, user: { relationTo: 'users', value: owner.id } }, overrideAccess: true })
    assert.ok(lock.id)
  }
  console.log('mail-thread production CRUD and lock relations verified')
} finally { await payload.destroy() }
