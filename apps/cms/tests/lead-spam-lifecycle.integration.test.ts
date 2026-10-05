import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { classifyLeadAsSpam, deleteSpamLead, restoreLeadFromSpam } from '../src/lead-spam-lifecycle'
import { leadWhere } from '../src/lead-filters'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-lead-spam-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
const ledger = join(directory, 'deletions.ndjson')
writeFileSync(ledger, '', { mode: 0o600 }); process.env.RETENTION_TOMBSTONES_FILE = ledger
process.env.PAYLOAD_SECRET = 'lead-spam-lifecycle-test-secret-long-enough'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>
let owner: { id: string }

beforeAll(async () => {
  payload = await getPayload({ config })
  owner = await payload.create({ collection: 'users', data: { name: 'Lead Owner', email: 'lead-owner@example.test', roles: ['owner'] }, overrideAccess: true })
})
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

async function lead(name: string, data: Record<string, unknown> = {}) {
  return payload.create({ collection: 'inquiries', data: { email: `${name}@example.test`, name, message: 'Plain inquiry content.', topic: 'general', sourcePage: '/contact', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: randomUUID(), stage: 'contacted', urgent: false, ...data }, overrideAccess: true })
}

describe('audited lead spam lifecycle', () => {
  it('keeps legacy null classification active and suppresses every queued notification when marked spam', async () => {
    const item = await lead('legacy-null', { spam: null })
    const active = await payload.find({ collection: 'inquiries', where: leadWhere({ urgent: false, received: 'all', page: 1, spam: false }, true), limit: 100, depth: 0, overrideAccess: true })
    expect(active.docs.map((doc) => doc.id)).toContain(item.id)
    for (let index = 0; index < 101; index += 1) await payload.create({ collection: 'notification-outbox', data: { inquiry: item.id, kind: 'new-lead', idempotencyKey: `spam-queued-${item.id}-${index}`, state: 'queued', payload: {}, recipientRules: [], recipients: [], channels: ['email'], sourceType: 'inquiry', sourceID: item.id, availableAt: new Date().toISOString() }, overrideAccess: true })

    const classified = await classifyLeadAsSpam(payload, item.id, owner.id)
    expect(classified).toMatchObject({ id: item.id, spam: true, spamPreviousStage: 'contacted', spamMarkedAt: expect.any(String) })
    expect((await payload.count({ collection: 'notification-outbox', where: { inquiry: { equals: item.id } }, overrideAccess: true })).totalDocs).toBe(0)
    const audit = (await payload.find({ collection: 'audit-events', where: { event: { equals: 'lead.spam_classified' } }, overrideAccess: true })).docs[0]!
    expect(audit.detail).toEqual({ lead: item.id, previousStage: 'contacted', cancelledNotifications: 101, revokedDrafts: 0, revokedGrants: 0 })

    const restored = await restoreLeadFromSpam(payload, item.id, owner.id)
    expect(restored).toMatchObject({ id: item.id, spam: false, stage: 'new', spamMarkedAt: null, spamPreviousStage: null })
  }, 120_000)

  it('blocks active delivery, then deletes exact spam PII while removing delivery copies and retaining ID-only audit history', async () => {
    const item = await lead('delete-me', { spam: true, spamMarkedAt: new Date().toISOString(), spamPreviousStage: 'contacted' })
    for (let index = 0; index < 101; index += 1) await payload.create({ collection: 'notification-outbox', data: { inquiry: item.id, kind: 'new-lead', idempotencyKey: `spam-completed-${item.id}-${index}`, state: 'delivered', payload: {}, recipientRules: [], recipients: [], channels: ['email'], sourceType: 'inquiry', sourceID: item.id, availableAt: new Date().toISOString() }, overrideAccess: true })
    const queued = await payload.create({ collection: 'notification-outbox', data: { inquiry: item.id, kind: 'new-lead', idempotencyKey: `spam-active-${item.id}`, state: 'queued', payload: {}, recipientRules: [], recipients: [], channels: ['email'], sourceType: 'inquiry', sourceID: item.id, availableAt: new Date().toISOString() }, overrideAccess: true })
    await expect(deleteSpamLead(payload, item.id, owner.id)).rejects.toMatchObject({ code: 'ACTIVE_SEND' })
    expect(readFileSync(ledger, 'utf8')).toBe('')
    await expect(payload.update({ collection: 'inquiries', id: item.id, data: { notes: 'Bypass attempt' }, overrideAccess: true })).rejects.toThrow('Restore spam before editing')
    await payload.update({ collection: 'notification-outbox', id: queued.id, data: { state: 'delivered' }, overrideAccess: true })
    await deleteSpamLead(payload, item.id, owner.id)
    expect((await payload.count({ collection: 'inquiries', where: { id: { equals: item.id } }, overrideAccess: true })).totalDocs).toBe(0)
    await expect(payload.findByID({ collection: 'notification-outbox', id: queued.id, depth: 0, overrideAccess: true })).rejects.toMatchObject({ status: 404 })
    expect((await payload.count({ collection: 'notification-outbox', where: { inquiry: { equals: item.id } }, overrideAccess: true })).totalDocs).toBe(0)
    const audit = (await payload.find({ collection: 'audit-events', where: { event: { equals: 'lead.spam_deleted' } }, overrideAccess: true })).docs[0]!
    expect(audit.detail).toEqual({ lead: item.id })
    expect(JSON.stringify(audit)).not.toContain('delete-me@example.test')
  })
})
