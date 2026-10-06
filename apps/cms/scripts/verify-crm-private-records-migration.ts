import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPayload } from 'payload'
import config from '../payload.config.js'

const payload = await getPayload({ config })
try {
  const owner = await payload.create({ collection: 'users', data: { email: 'crm-migration-owner@example.test', name: 'CRM migration owner', roles: ['owner'] }, overrideAccess: true })
  const lead = await payload.create({ collection: 'inquiries', data: { email: 'crm-migration-lead@example.test', message: 'Migration probe lead.', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: `crm-migration-${randomUUID()}`, stage: 'new' }, overrideAccess: true })
  const application = await payload.create({ collection: 'applications', data: { name: 'CRM migration applicant', email: 'crm-migration-applicant@example.test', coverLetter: 'Migration probe application.', consent: true, jobId: randomUUID(), resumeKey: 'migration-probe', idempotencyKey: randomUUID(), status: 'new' }, overrideAccess: true })
  assert.equal(application.notes, null)
  const updated = await payload.update({ collection: 'applications', id: application.id, data: { notes: 'A durable private application note.' }, overrideAccess: true })
  assert.equal(updated.notes, 'A durable private application note.')
  const key = `crm-external-reply-${randomUUID()}`
  const reply = await payload.create({ collection: 'external-replies', data: { lead: lead.id, sentAt: new Date().toISOString(), subject: 'Private reply subject', summary: 'Private reply summary.', recordedBy: owner.id, idempotencyKey: key }, overrideAccess: true })
  assert.equal((await payload.findByID({ collection: 'external-replies', id: reply.id, overrideAccess: true })).summary, 'Private reply summary.')
  await assert.rejects(() => payload.create({ collection: 'external-replies', data: { lead: lead.id, sentAt: new Date().toISOString(), subject: 'Duplicate', summary: 'Duplicate private reply.', recordedBy: owner.id, idempotencyKey: key }, overrideAccess: true }))
  console.log('CRM private records production persistence and uniqueness verified')
} finally { await payload.destroy() }
