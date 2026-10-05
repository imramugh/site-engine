import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { defaultNotificationPreferences, enqueueNotification, parseNotificationPreferences, readNotificationPreferences, saveNotificationPreferences, type NotificationPreference } from '../src/notification-settings'
import { withPayloadTransaction } from '../src/auth-transaction'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-notifications-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'notification-settings-test-secret-long-enough'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

describe('private notification routing settings', () => {
  it('uses all six safe defaults when no settings row exists and validates exact event coverage', async () => {
    expect(await readNotificationPreferences(payload)).toEqual(defaultNotificationPreferences)
    expect(defaultNotificationPreferences).toHaveLength(6)
    expect(parseNotificationPreferences(defaultNotificationPreferences)).toEqual(defaultNotificationPreferences)
    expect(parseNotificationPreferences(defaultNotificationPreferences.slice(1))).toBeUndefined()
    expect(parseNotificationPreferences(defaultNotificationPreferences.map((entry) => entry.kind === 'new-lead' ? { ...entry, channels: [] } : entry))).toBeUndefined()
  })

  it('persists settings with audit evidence while direct collection access remains private', async () => {
    const owner = await payload.create({ collection: 'users', data: { name: 'Notification Owner', email: 'notification-owner@example.test', roles: ['owner'] }, overrideAccess: true })
    const events: NotificationPreference[] = defaultNotificationPreferences.map((entry) => entry.kind === 'new-lead' ? { ...entry, recipients: ['owner'] } : entry)
    await withPayloadTransaction(payload, (req) => saveNotificationPreferences(payload, req, events, owner.id))
    expect(await readNotificationPreferences(payload)).toEqual(events)
    await expect(payload.find({ collection: 'notification-preferences', user: owner, overrideAccess: false })).rejects.toThrow('not allowed')
    const audit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'notification.preferences_updated' } }, overrideAccess: true })
    expect(audit.docs).toHaveLength(1)
  })

  it('resolves current enabled staff roles and private urgent contacts into each durable intent', async () => {
    const settingsOwner = (await payload.find({ collection: 'users', where: { email: { equals: 'notification-owner@example.test' } }, limit: 1, overrideAccess: true })).docs[0]!
    await withPayloadTransaction(payload, (req) => saveNotificationPreferences(payload, req, defaultNotificationPreferences, settingsOwner.id))
    const sales = await payload.create({ collection: 'users', data: { name: 'Sales', email: 'sales-notify@example.test', roles: ['sales'] }, overrideAccess: true })
    await payload.create({ collection: 'users', data: { name: 'Disabled Sales', email: 'disabled-notify@example.test', roles: ['sales'], disabled: true }, overrideAccess: true })
    const contact = await payload.create({ collection: 'urgent-contacts', data: { name: 'Incident Lead', email: 'incident@example.test', mobile: '+1 416 555 0110', enabled: true }, overrideAccess: true })
    await payload.create({ collection: 'urgent-contacts', data: { name: 'Disabled Contact', email: 'off@example.test', enabled: false }, overrideAccess: true })
    const lead = await enqueueNotification(payload, undefined, { kind: 'new-lead', idempotencyKey: 'settings-lead-event', sourceType: 'inquiry', sourceID: 'source-lead', payload: { safe: true } })
    expect(lead?.recipients).toEqual(expect.arrayContaining([{ type: 'staff', id: sales.id, email: sales.email }]))
    expect(lead?.recipients).not.toEqual(expect.arrayContaining([expect.objectContaining({ email: 'disabled-notify@example.test' })]))
    const urgent = await enqueueNotification(payload, undefined, { kind: 'active-incident-lead', idempotencyKey: 'settings-urgent-event', sourceType: 'inquiry', sourceID: 'source-urgent', payload: { safe: true } })
    expect(urgent?.recipients).toEqual(expect.arrayContaining([{ type: 'urgent-contact', id: contact.id, email: contact.email, mobile: contact.mobile }]))
    expect(urgent).toMatchObject({ state: 'queued', channels: ['email', 'sms'] })
  })

  it('keeps urgent intent enabled when settings are missing and omits only explicitly disabled events', async () => {
    await payload.delete({ collection: 'notification-preferences', where: {}, overrideAccess: true })
    await expect(enqueueNotification(payload, undefined, { kind: 'active-incident-lead', idempotencyKey: 'default-urgent-event', payload: {} })).resolves.toMatchObject({ kind: 'active-incident-lead' })
    const owner = (await payload.find({ collection: 'users', where: { email: { equals: 'notification-owner@example.test' } }, limit: 1, overrideAccess: true })).docs[0]!
    const events = defaultNotificationPreferences.map((entry) => entry.kind === 'new-lead' ? { ...entry, enabled: false } : entry)
    await withPayloadTransaction(payload, (req) => saveNotificationPreferences(payload, req, events, owner.id))
    await expect(enqueueNotification(payload, undefined, { kind: 'new-lead', idempotencyKey: 'disabled-lead-event', payload: {} })).resolves.toBeUndefined()
  })

  it('queues a new-application intent from the canonical application create hook', async () => {
    const application = await payload.create({ collection: 'applications', data: { name: 'Applicant', email: 'applicant-notification@example.test', coverLetter: 'A bounded application fixture.', consent: true, jobId: '00000000-0000-4000-8000-000000000101', resumeKey: '00000000-0000-4000-8000-000000000102-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', idempotencyKey: '00000000-0000-4000-8000-000000000103' }, overrideAccess: true })
    const queued = await payload.find({ collection: 'notification-outbox', where: { sourceID: { equals: application.id } }, limit: 1, depth: 0, overrideAccess: true })
    expect(queued.docs[0]).toMatchObject({ kind: 'new-job-application', sourceType: 'application', sourceID: application.id, recipientRules: ['hiring', 'owner'], channels: ['email'], state: 'queued' })
  })
})
