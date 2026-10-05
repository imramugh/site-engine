import type { Payload, PayloadRequest } from 'payload'
import { withPayloadTransaction } from './auth-transaction'
import { assertLeadAcceptsOutbound } from './lead-outbound'

export const notificationEventKinds = ['new-lead', 'active-incident-lead', 'new-job-application', 'change-set-submitted', 'follow-ups-due', 'publish-or-integration-failed'] as const
export type NotificationEventKind = typeof notificationEventKinds[number]
export const notificationRecipientKinds = ['owner', 'sales', 'hiring', 'approver', 'lead-owner', 'urgent-contact'] as const
export type NotificationRecipientKind = typeof notificationRecipientKinds[number]
export const notificationChannels = ['email', 'sms'] as const
export type NotificationChannel = typeof notificationChannels[number]

export type NotificationPreference = {
  kind: NotificationEventKind
  enabled: boolean
  recipients: NotificationRecipientKind[]
  channels: NotificationChannel[]
  cadence: 'immediate' | 'daily-0800'
}

export const defaultNotificationPreferences: NotificationPreference[] = [
  { kind: 'new-lead', enabled: true, recipients: ['owner', 'sales'], channels: ['email'], cadence: 'immediate' },
  { kind: 'active-incident-lead', enabled: true, recipients: ['urgent-contact', 'owner'], channels: ['email', 'sms'], cadence: 'immediate' },
  { kind: 'new-job-application', enabled: true, recipients: ['hiring', 'owner'], channels: ['email'], cadence: 'immediate' },
  { kind: 'change-set-submitted', enabled: true, recipients: ['approver'], channels: ['email'], cadence: 'immediate' },
  { kind: 'follow-ups-due', enabled: true, recipients: ['lead-owner'], channels: ['email'], cadence: 'daily-0800' },
  { kind: 'publish-or-integration-failed', enabled: true, recipients: ['owner'], channels: ['email'], cadence: 'immediate' },
]

const unique = <T extends string>(values: T[]) => [...new Set(values)]

export function parseNotificationPreferences(value: unknown): NotificationPreference[] | undefined {
  if (!Array.isArray(value) || value.length !== notificationEventKinds.length) return undefined
  const parsed: NotificationPreference[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
    const record = item as Record<string, unknown>
    if (!notificationEventKinds.includes(record.kind as NotificationEventKind) || typeof record.enabled !== 'boolean' || !Array.isArray(record.recipients) || !Array.isArray(record.channels) || !['immediate', 'daily-0800'].includes(String(record.cadence))) return undefined
    const recipients = unique(record.recipients.filter((entry): entry is NotificationRecipientKind => typeof entry === 'string' && notificationRecipientKinds.includes(entry as NotificationRecipientKind)))
    const channels = unique(record.channels.filter((entry): entry is NotificationChannel => typeof entry === 'string' && notificationChannels.includes(entry as NotificationChannel)))
    if (recipients.length !== record.recipients.length || channels.length !== record.channels.length || recipients.length === 0 || channels.length === 0) return undefined
    if (record.kind === 'follow-ups-due' && record.cadence !== 'daily-0800') return undefined
    if (record.kind !== 'follow-ups-due' && record.cadence !== 'immediate') return undefined
    parsed.push({ kind: record.kind as NotificationEventKind, enabled: record.enabled, recipients, channels, cadence: record.cadence as NotificationPreference['cadence'] })
  }
  return notificationEventKinds.every((kind) => parsed.filter((entry) => entry.kind === kind).length === 1) ? parsed.sort((a, b) => notificationEventKinds.indexOf(a.kind) - notificationEventKinds.indexOf(b.kind)) : undefined
}

export async function readNotificationPreferences(payload: Payload, req?: PayloadRequest): Promise<NotificationPreference[]> {
  const result = await payload.find({ collection: 'notification-preferences', where: { key: { equals: 'active' } }, limit: 1, depth: 0, overrideAccess: true, req })
  return parseNotificationPreferences(result.docs[0]?.events) ?? structuredClone(defaultNotificationPreferences)
}

export async function saveNotificationPreferences(payload: Payload, req: PayloadRequest, events: NotificationPreference[], actor: string) {
  const existing = await payload.find({ collection: 'notification-preferences', where: { key: { equals: 'active' } }, limit: 1, depth: 0, overrideAccess: true, req })
  const data = { key: 'active', events, updatedBy: actor }
  const saved = existing.docs[0]
    ? await payload.update({ collection: 'notification-preferences', id: existing.docs[0].id, data, overrideAccess: true, req })
    : await payload.create({ collection: 'notification-preferences', data, overrideAccess: true, req })
  await payload.create({ collection: 'audit-events', data: { event: 'notification.preferences_updated', user: actor, actor, detail: { events: events.map((entry) => entry.kind) } }, overrideAccess: true, req })
  return saved
}

type ResolvedRecipient = { type: 'staff' | 'urgent-contact'; id: string; email: string; mobile?: string }

async function resolveRecipients(payload: Payload, req: PayloadRequest | undefined, rules: NotificationRecipientKind[], leadOwnerID?: string): Promise<ResolvedRecipient[]> {
  const staffRoles = rules.filter((rule): rule is 'owner' | 'sales' | 'hiring' | 'approver' => ['owner', 'sales', 'hiring', 'approver'].includes(rule))
  const [users, contacts] = await Promise.all([
    staffRoles.length || rules.includes('lead-owner') ? payload.find({ collection: 'users', limit: 100, pagination: false, depth: 0, overrideAccess: true, req }) : Promise.resolve({ docs: [] }),
    rules.includes('urgent-contact') ? payload.find({ collection: 'urgent-contacts', where: { enabled: { equals: true } }, limit: 50, pagination: false, depth: 0, overrideAccess: true, req }) : Promise.resolve({ docs: [] }),
  ])
  const resolved: ResolvedRecipient[] = []
  for (const user of users.docs) {
    if (user.disabled || typeof user.email !== 'string') continue
    const userRoles = Array.isArray(user.roles) ? user.roles : []
    if (!staffRoles.some((role) => userRoles.includes(role)) && !(rules.includes('lead-owner') && user.id === leadOwnerID)) continue
    resolved.push({ type: 'staff', id: user.id, email: user.email })
  }
  for (const contact of contacts.docs) if (typeof contact.email === 'string') resolved.push({ type: 'urgent-contact', id: contact.id, email: contact.email, ...(typeof contact.mobile === 'string' && contact.mobile ? { mobile: contact.mobile } : {}) })
  return [...new Map(resolved.map((recipient) => [`${recipient.type}:${recipient.id}`, recipient])).values()]
}

export async function enqueueNotification(payload: Payload, req: PayloadRequest | undefined, input: { kind: NotificationEventKind; idempotencyKey: string; inquiry?: string; sourceType?: string; sourceID?: string; leadOwnerID?: string; payload: Record<string, unknown> }) {
  const enqueue = async (transaction: PayloadRequest) => {
    if (input.inquiry) {
      try { await assertLeadAcceptsOutbound(payload, input.inquiry, transaction) } catch (error) { if (error instanceof Error && error.message === 'lead_is_spam') return undefined; throw error }
    }
    const preference = (await readNotificationPreferences(payload, transaction)).find((entry) => entry.kind === input.kind)
    if (!preference?.enabled) return undefined
    const existing = await payload.find({ collection: 'notification-outbox', where: { idempotencyKey: { equals: input.idempotencyKey } }, limit: 1, depth: 0, overrideAccess: true, req: transaction })
    if (existing.docs[0]) return existing.docs[0]
    const recipients = await resolveRecipients(payload, transaction, preference.recipients, input.leadOwnerID)
    try { return await payload.create({
      collection: 'notification-outbox', data: { inquiry: input.inquiry, kind: input.kind, idempotencyKey: input.idempotencyKey, state: 'queued', payload: input.payload, recipientRules: preference.recipients, recipients, channels: preference.channels, sourceType: input.sourceType, sourceID: input.sourceID, availableAt: new Date().toISOString() }, overrideAccess: true, req: transaction,
    }) } catch (error) {
      const raced = await payload.find({ collection: 'notification-outbox', where: { idempotencyKey: { equals: input.idempotencyKey } }, limit: 1, depth: 0, overrideAccess: true, req: transaction })
      if (raced.docs[0]) return raced.docs[0]
      throw error
    }
  }
  return req?.transactionID ? enqueue(req) : withPayloadTransaction(payload, enqueue)
}
