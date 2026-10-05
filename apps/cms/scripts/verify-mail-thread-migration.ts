import assert from 'node:assert/strict'
import { getPayload } from 'payload'
import config from '../payload.config.js'
import { down, up } from '../src/migrations/20261005_230000_mail_threads.js'

const payload = await getPayload({ config })
try {
  const owner = await payload.create({ collection: 'users', data: { email: 'probe-owner@example.test', name: 'Probe owner', roles: ['owner'] }, overrideAccess: true })
  const sales = await payload.create({ collection: 'users', data: { email: 'probe-sales@example.test', name: 'Probe sales', roles: ['sales'] }, overrideAccess: true })
  const hiring = await payload.create({ collection: 'users', data: { email: 'probe-hiring@example.test', name: 'Probe hiring', roles: ['hiring'] }, overrideAccess: true })
  const lead = await payload.create({ collection: 'inquiries', data: { email: 'probe-lead@example.test', message: 'probe', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: `probe-${crypto.randomUUID()}`, stage: 'new' }, overrideAccess: true })
  const app = await payload.create({ collection: 'applications', data: { name: 'Probe', email: 'probe-app@example.test', coverLetter: 'probe', consent: true, jobId: crypto.randomUUID(), resumeKey: 'probe', idempotencyKey: crypto.randomUUID(), status: 'new' }, overrideAccess: true })
  const mailbox = await payload.create({ collection: 'mailbox-configurations', data: { name: 'Probe', provider: 'smtp', primaryAddress: 'probe@example.test', aliases: [], verifiedAliases: [], host: 'smtp.example.test', port: 587, security: 'starttls', username: 'probe', encryptedCredential: 'probe', credentialRevision: 'probe', health: 'connected' }, overrideAccess: true, context: { mailboxInternal: true } })
  for (const [target, id] of [['lead', lead.id], ['application', app.id]] as const) {
    const thread = await payload.create({ collection: 'mail-threads', data: { [target]: id, mailbox: mailbox.id, provider: 'smtp', providerConversationID: `probe-${target}` }, overrideAccess: true })
    const message = await payload.create({ collection: 'mail-thread-messages', data: { thread: thread.id, mailbox: mailbox.id, [target]: id, providerMessageID: `probe-message-${target}`, direction: 'inbound', sender: 'visitor@example.test', recipient: 'probe@example.test', subject: 'probe', body: 'probe', receivedAt: new Date().toISOString() }, overrideAccess: true })
    assert.equal((await payload.findByID({ collection: 'mail-thread-messages', id: message.id, overrideAccess: true })).id, message.id)
    const updated = await payload.update({ collection: 'mail-thread-messages', id: message.id, data: { body: 'probe updated' }, overrideAccess: true })
    assert.equal(updated.body, 'probe updated')
    const locks = []
    for (const [relationTo, value] of [['mail-threads', thread.id], ['mail-thread-messages', message.id]] as const) {
      const lock = await payload.create({ collection: 'payload-locked-documents', data: { document: { relationTo, value }, user: { relationTo: 'users', value: owner.id } }, overrideAccess: true })
      assert.ok(lock.id)
      locks.push(lock.id)
    }
    const allowedUser = target === 'lead' ? sales : hiring
    const deniedUser = target === 'lead' ? hiring : sales
    const allowed = await payload.find({ collection: 'mail-thread-messages', where: { id: { equals: message.id } }, user: allowedUser, overrideAccess: false })
    const denied = await payload.find({ collection: 'mail-thread-messages', where: { id: { equals: message.id } }, user: deniedUser, overrideAccess: false })
    assert.equal(allowed.totalDocs, 1)
    assert.equal(denied.totalDocs, 0)
    for (const lock of locks) await payload.delete({ collection: 'payload-locked-documents', id: lock, overrideAccess: true })
    await payload.delete({ collection: 'mail-thread-messages', id: message.id, overrideAccess: true })
    assert.equal((await payload.find({ collection: 'mail-thread-messages', where: { id: { equals: message.id } }, overrideAccess: true })).totalDocs, 0)
    await payload.delete({ collection: 'mail-threads', id: thread.id, overrideAccess: true })
  }
  // The CLI applied this migration. Exercise its actual down/up functions against
  // the production SQLite adapter after all mail rows and lock rows are removed.
  const migrationArgs = { db: payload.db.drizzle, payload, req: {} } as never
  await down(migrationArgs)
  await up(migrationArgs)
  const postCycleThread = await payload.create({ collection: 'mail-threads', data: { lead: lead.id, mailbox: mailbox.id, provider: 'smtp', providerConversationID: 'probe-post-cycle' }, overrideAccess: true })
  assert.ok(postCycleThread.id)
  console.log('mail-thread production CRUD, lock relations, and down/up cycle verified')
} finally { await payload.destroy() }
