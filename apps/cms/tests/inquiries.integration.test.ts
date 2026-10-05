import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { createAcceptedInquiry, InquiryIdempotencyCollisionError, InquiryRateLimitedError, inquiryTopics, type InquiryTopic, validateInquiry, validateLeadAssignee } from '../src/inquiries'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-inquiries-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'inquiry-integration-secret-that-is-long-enough'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

const fixture = (key: string, topic: InquiryTopic = 'project') => ({ email: 'visitor@example.test', message: '<img src=x onerror=alert(1)> Please help with a project.', topic, sourcePage: '/contact', consent: true, idempotencyKey: key, name: 'Synthetic visitor', telephone: '+1 555 0123', company: 'Example Company' })

describe('ENG-019 real SQLite intake and outbox', () => {
  it('rejects malformed submissions before persistence', async () => {
    const invalid = validateInquiry({ ...fixture('invalid-idempotency-key-1234'), email: 'bad', consent: false })
    expect(invalid.input).toBeUndefined()
    expect(await payload.count({ collection: 'inquiries', overrideAccess: true })).toMatchObject({ totalDocs: 0 })
  })

  it('persists one urgent lead and queues durable notifications idempotently', async () => {
    const input = validateInquiry(fixture('active-incident-idempotency-1234', 'active-incident')).input!
    const first = await createAcceptedInquiry(payload, input)
    expect('suppressed' in first).toBe(false)
    const again = await createAcceptedInquiry(payload, input)
    expect('suppressed' in again ? false : again.duplicate).toBe(true)
    const leads = await payload.find({ collection: 'inquiries', where: { email: { equals: input.email } }, overrideAccess: true })
    expect(leads.docs).toHaveLength(1)
    expect(leads.docs[0]).toMatchObject({ topic: 'active-incident', urgent: true, stage: 'new', message: input.message, name: 'Synthetic visitor', telephone: '+1 555 0123', company: 'Example Company' })
    const queued = await payload.find({ collection: 'notification-outbox', where: { inquiry: { equals: leads.docs[0].id } }, overrideAccess: true })
    expect(queued.docs.map((event) => event.kind).sort()).toEqual(['lead-received', 'urgent-lead-alert'])
    expect(queued.docs.every((event) => event.state === 'queued')).toBe(true)
  })

  it('persists every current and legacy topic without changing urgency semantics', async () => {
    for (const [index, topic] of inquiryTopics.entries()) {
      const input = validateInquiry({ ...fixture(`topic-${topic}-idempotency-${index}-1234`, topic), email: `topic-${index}@example.test` }).input!
      await createAcceptedInquiry(payload, input)
      const stored = await payload.find({ collection: 'inquiries', where: { idempotencyKey: { equals: input.idempotencyKey } }, overrideAccess: true })
      expect(stored.docs).toHaveLength(1)
      expect(stored.docs[0]).toMatchObject({ topic, urgent: topic === 'active-incident' })
    }
  })

  it('suppresses honeypot submissions and rate limits repeated non-idempotent requests', async () => {
    const spam = await createAcceptedInquiry(payload, { ...validateInquiry(fixture('honeypot-idempotency-key-1234')).input!, honeypot: 'filled by bot' })
    expect(spam).toEqual({ suppressed: true })
    const first = validateInquiry(fixture('rate-limit-idempotency-key-1234')).input!
    await createAcceptedInquiry(payload, { ...first, email: 'limited@example.test' })
    await expect(createAcceptedInquiry(payload, { ...first, email: 'limited@example.test', idempotencyKey: 'different-rate-limit-key-1234' })).rejects.toBeInstanceOf(InquiryRateLimitedError)
  })

  it('handles idempotency replay conflicts and concurrent retries without duplicate leads', async () => {
    const input = { ...validateInquiry(fixture('concurrent-idempotency-key-1234')).input!, email: 'concurrent@example.test' }
    const outcomes = await Promise.all([createAcceptedInquiry(payload, input), createAcceptedInquiry(payload, input)])
    expect(outcomes.filter((outcome) => !('suppressed' in outcome) && outcome.duplicate)).toHaveLength(1)
    await expect(createAcceptedInquiry(payload, { ...input, message: 'Different content using the same key.' })).rejects.toBeInstanceOf(InquiryIdempotencyCollisionError)
    const leads = await payload.find({ collection: 'inquiries', where: { idempotencyKey: { equals: input.idempotencyKey } }, overrideAccess: true })
    expect(leads.docs).toHaveLength(1)
  })

  it('allows only active owners or sales users to be assigned leads', async () => {
    const sales = await payload.create({ collection: 'users', data: { email: 'sales-assignee@example.test', name: 'Sales Assignee', roles: ['sales'] }, overrideAccess: true })
    const editor = await payload.create({ collection: 'users', data: { email: 'editor-assignee@example.test', name: 'Editor Assignee', roles: ['editor'] }, overrideAccess: true })
    const disabled = await payload.create({ collection: 'users', data: { email: 'disabled-assignee@example.test', name: 'Disabled Assignee', roles: ['sales'], disabled: true }, overrideAccess: true })
    await expect(validateLeadAssignee(payload, sales.id)).resolves.toBe(sales.id)
    await expect(validateLeadAssignee(payload, editor.id)).rejects.toThrow('active sales or owner')
    await expect(validateLeadAssignee(payload, disabled.id)).rejects.toThrow('active sales or owner')
    await expect(validateLeadAssignee(payload, null)).resolves.toBeNull()
  })
  it('enforces workflow and immutable consent through direct collection writes', async () => {
    const sales = await payload.find({ collection: 'users', where: { email: { equals: 'sales-assignee@example.test' } }, overrideAccess: true })
    const editor = await payload.find({ collection: 'users', where: { email: { equals: 'editor-assignee@example.test' } }, overrideAccess: true })
    const lead = (await payload.find({ collection: 'inquiries', overrideAccess: true })).docs[0]!
    const update = (data: Record<string, unknown>) => payload.update({ collection: 'inquiries', id: lead.id, data, user: sales.docs[0], overrideAccess: false })
    await expect(update({ stage: 'won' })).rejects.toThrow('transition')
    await expect(update({ consentBasis: 'staff-recorded' })).rejects.toThrow('consent evidence')
    await expect(update({ assignee: editor.docs[0]!.id })).rejects.toThrow('active sales or owner')
    await expect(update({ stage: 'qualified', notes: '<script>plain text only</script>', assignee: sales.docs[0]!.id })).resolves.toMatchObject({ stage: 'qualified', notes: '<script>plain text only</script>' })
  })

  it('deletes queued notification copies atomically when an owner deletes a lead', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'deleting-owner@example.test', name: 'Owner', roles: ['owner'] }, overrideAccess: true })
    const lead = (await payload.find({ collection: 'inquiries', where: { urgent: { equals: true } }, overrideAccess: true })).docs[0]!
    expect((await payload.count({ collection: 'notification-outbox', where: { inquiry: { equals: lead.id } }, overrideAccess: true })).totalDocs).toBe(2)
    await expect(payload.delete({ collection: 'inquiries', id: lead.id, user: owner, overrideAccess: false })).resolves.toMatchObject({ id: lead.id })
    expect((await payload.count({ collection: 'notification-outbox', where: { inquiry: { equals: lead.id } }, overrideAccess: true })).totalDocs).toBe(0)
  })

})
