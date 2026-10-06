import { randomUUID } from 'node:crypto'
import type { Payload } from 'payload'
import { sendAreaMail } from './mailboxes'
import { withPayloadTransaction } from './auth-transaction'
import { readNotificationPreferences } from './notification-settings'

type Recipient = { type: 'staff' | 'urgent-contact'; id: string; email: string }
type Outbox = { id: string; kind: string; recipients: Recipient[]; channels: string[]; recipientRules: string[]; sourceType?: string; sourceID?: string; inquiry?: string }
const retryDelay = 5 * 60_000
const maxPreSendAttempts = 5
const dispatchLocks = new Map<string, Promise<void>>()

function message(kind: string, id: string) {
  const label: Record<string, string> = { 'new-lead': 'New lead', 'active-incident-lead': 'Active incident lead', 'new-job-application': 'New job application', 'change-set-submitted': 'Change set submitted', 'publish-or-integration-failed': 'Publish or integration failure' }
  const configured = new URL(process.env.PAYLOAD_PUBLIC_SERVER_URL ?? '')
  if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password || configured.origin === 'null') throw new Error('notification_public_origin_invalid')
  return { subject: `${label[kind] ?? 'Operations notification'} (${id})`, body: `An operations event requires review.\n\nEvent: ${kind}\nReference: ${id}\nOpen: ${new URL('/operations', configured.origin).toString()}\n` }
}
function key(outbox: string, recipient: Recipient, channel: string) { return `${outbox}:${recipient.type}:${recipient.id}:${channel}` }
async function exclusively<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
  const previous = dispatchLocks.get(lockKey) ?? Promise.resolve()
  let release: () => void = () => undefined
  const current = new Promise<void>((resolve) => { release = resolve })
  dispatchLocks.set(lockKey, current)
  await previous
  try { return await operation() } finally { release(); if (dispatchLocks.get(lockKey) === current) dispatchLocks.delete(lockKey) }
}

async function updateOutboxState(store: any, outbox: Outbox) {
  const expected = (outbox.recipients ?? []).length * (outbox.channels ?? []).length
  if (!expected) { await store.update({ collection: 'notification-outbox', id: outbox.id, data: { state: 'failed' }, overrideAccess: true }); return }
  const receipts = await store.find({ collection: 'notification-deliveries', where: { outbox: { equals: outbox.id } }, limit: 0, pagination: false, depth: 0, overrideAccess: true })
  if (receipts.totalDocs < expected || receipts.docs.some((item: { state: string }) => ['queued', 'retryable', 'processing'].includes(item.state))) return
  const attention = receipts.docs.some((item: { state: string }) => ['unknown', 'failed', 'unsupported'].includes(item.state))
  await store.update({ collection: 'notification-outbox', id: outbox.id, data: { state: attention ? 'failed' : 'delivered' }, overrideAccess: true })
}
async function deferOutbox(store: any, outboxID: string, now: Date) {
  await store.update({ collection: 'notification-outbox', id: outboxID, data: { availableAt: new Date(now.getTime() + retryDelay).toISOString() }, overrideAccess: true })
}
async function retryPreSend(store: any, outbox: Outbox, id: string, attempts: number, now: Date, code: 'mailbox-not-ready' | 'mailbox-not-configured' | 'smtp-target-rejected') {
  const exhausted = attempts >= maxPreSendAttempts
  await store.update({ collection: 'notification-deliveries', id, data: exhausted
    ? { state: 'failed', leaseToken: null, leaseExpiresAt: null, failureCode: code, completedAt: now.toISOString() }
    : { state: 'retryable', leaseToken: null, leaseExpiresAt: null, nextAttemptAt: new Date(now.getTime() + retryDelay).toISOString(), failureCode: code }, overrideAccess: true })
  if (!exhausted) await deferOutbox(store, outbox.id, now)
  await updateOutboxState(store, outbox)
  return exhausted ? 'failed' : 'retryable'
}
async function recipientEligible(payload: Payload, outbox: Outbox, recipient: Recipient, channel: string) {
  const preference = (await readNotificationPreferences(payload)).find((item) => item.kind === outbox.kind)
  if (!preference?.enabled || !preference.channels.includes(channel as 'email' | 'sms') || !preference.recipients.some((rule) => outbox.recipientRules?.includes(rule))) return false
  if (recipient.type === 'urgent-contact') {
    const contact = await payload.findByID({ collection: 'urgent-contacts', id: recipient.id, depth: 0, overrideAccess: true }).catch(() => null) as { enabled?: boolean; email?: string } | null
    return Boolean(contact?.enabled && contact.email?.toLowerCase() === recipient.email.toLowerCase() && preference.recipients.includes('urgent-contact'))
  }
  const user = await payload.findByID({ collection: 'users', id: recipient.id, depth: 0, overrideAccess: true }).catch(() => null) as { disabled?: boolean; email?: string; roles?: string[] } | null
  if (!user || user.disabled || user.email?.toLowerCase() !== recipient.email.toLowerCase()) return false
  if (outbox.kind !== 'active-incident-lead') {
    const muted = await (payload as any).find({ collection: 'notification-user-preferences', where: { user: { equals: recipient.id } }, limit: 1, depth: 0, overrideAccess: true })
    if (Array.isArray(muted.docs[0]?.mutedKinds) && muted.docs[0].mutedKinds.includes(outbox.kind)) return false
  }
  const roleMatch = preference.recipients.some((rule) => ['owner', 'sales', 'hiring', 'approver'].includes(rule) && user.roles?.includes(rule))
  if (roleMatch) return true
  if (!preference.recipients.includes('lead-owner') || outbox.sourceType !== 'inquiry') return false
  const inquiry = await payload.findByID({ collection: 'inquiries', id: String(outbox.sourceID ?? outbox.inquiry ?? ''), depth: 0, overrideAccess: true }).catch(() => null) as { assignee?: string } | null
  return inquiry?.assignee === recipient.id
}

/** Executes at most one recipient delivery. Call only from an internal worker. */
export async function dispatchOneNotification(payload: Payload, now = new Date()): Promise<{ id: string; state: string } | null> {
  return exclusively('notification-dispatch', () => dispatchOneNotificationLocked(payload, now))
}

async function dispatchOneNotificationLocked(payload: Payload, now: Date): Promise<{ id: string; state: string } | null> {
  // payload-types are generated at image build; retain local compatibility for
  // this newly migrated collection before that generation step.
  const store = payload as any
  const outboxes = await store.find({ collection: 'notification-outbox', where: { and: [{ state: { equals: 'queued' } }, { availableAt: { less_than_equal: now.toISOString() } }] }, sort: 'availableAt', limit: 25, pagination: false, depth: 0, overrideAccess: true })
  for (const raw of outboxes.docs as unknown as Outbox[]) {
    if (!(raw.recipients ?? []).length || !(raw.channels ?? []).length) { await updateOutboxState(store, raw); continue }
    for (const recipient of raw.recipients ?? []) for (const channel of raw.channels ?? []) {
      const idempotencyKey = key(raw.id, recipient, channel)
      const existing = await store.find({ collection: 'notification-deliveries', where: { idempotencyKey: { equals: idempotencyKey } }, limit: 1, depth: 0, overrideAccess: true })
      let delivery = existing.docs[0] as { id: string; state: string; nextAttemptAt?: string; leaseExpiresAt?: string } | undefined
      if (!delivery) {
        try { delivery = await store.create({ collection: 'notification-deliveries', data: { outbox: raw.id, idempotencyKey, recipient, state: channel === 'email' ? 'queued' : 'unsupported', attempts: 0, nextAttemptAt: now.toISOString(), ...(channel === 'email' ? {} : { failureCode: 'channel-unsupported', completedAt: now.toISOString() }) }, overrideAccess: true }) as typeof delivery }
        catch { delivery = (await store.find({ collection: 'notification-deliveries', where: { idempotencyKey: { equals: idempotencyKey } }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as typeof delivery }
      }
      if (delivery?.state === 'processing' && delivery.leaseExpiresAt && new Date(delivery.leaseExpiresAt) <= now) {
        // A crashed worker may have handed bytes to SMTP. Surface the ambiguity
        // and finalize its parent; never requeue or silently resend it.
        await store.update({ collection: 'notification-deliveries', id: delivery.id, data: { state: 'unknown', leaseToken: null, leaseExpiresAt: null, failureCode: 'lease-expired-outcome-unknown', completedAt: now.toISOString() }, overrideAccess: true })
        await updateOutboxState(store, raw)
        continue
      }
      if (!delivery || !['queued', 'retryable'].includes(delivery.state) || (delivery.nextAttemptAt && new Date(delivery.nextAttemptAt) > now) || (delivery.leaseExpiresAt && new Date(delivery.leaseExpiresAt) > now)) continue
      // A missing mapping is configuration, not an attempted provider send.
      // Keep the receipt queued and do not consume its finite pre-send budget.
      const mapping = await payload.find({ collection: 'mailbox-area-mappings', where: { area: { equals: 'notifications' } }, limit: 1, depth: 0, overrideAccess: true })
      if (!mapping.docs[0]) {
        await store.update({ collection: 'notification-deliveries', id: delivery.id, data: { state: 'queued', leaseToken: null, leaseExpiresAt: null, nextAttemptAt: new Date(now.getTime() + retryDelay).toISOString(), failureCode: 'mailbox-not-configured' }, overrideAccess: true })
        await deferOutbox(store, raw.id, now)
        return { id: delivery.id, state: 'queued' }
      }
      const token = randomUUID()
      const claimed = await withPayloadTransaction(payload, async req => {
        const current = await store.findByID({ collection: 'notification-deliveries', id: delivery!.id, depth: 0, overrideAccess: true, req }) as { state: string; nextAttemptAt: string; leaseExpiresAt?: string; attempts?: number }
        if (!['queued', 'retryable'].includes(current.state) || new Date(current.nextAttemptAt) > now || (current.leaseExpiresAt && new Date(current.leaseExpiresAt) > now)) return false
        await store.update({ collection: 'notification-deliveries', id: delivery!.id, data: { state: 'processing', attempts: Number(current.attempts ?? 0) + 1, leaseToken: token, leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString() }, overrideAccess: true, req })
        return true
      })
      if (!claimed) continue
      const sender = String(mapping.docs[0].senderAddress)
      try {
        if (!await recipientEligible(payload, raw, recipient, channel)) {
          await store.update({ collection: 'notification-deliveries', id: delivery.id, data: { state: 'failed', leaseToken: null, leaseExpiresAt: null, failureCode: 'recipient-no-longer-eligible', completedAt: now.toISOString() }, overrideAccess: true })
          await updateOutboxState(store, raw)
          return { id: delivery.id, state: 'failed' }
        }
        // A retention purge can delete the outbox between the original scan and
        // this point. Never send a stale event after that deletion.
        const stillPresent = await withPayloadTransaction(payload, async req => {
          const current = await store.findByID({ collection: 'notification-deliveries', id: delivery!.id, depth: 0, overrideAccess: true, req }).catch(() => null)
          const outbox = await store.findByID({ collection: 'notification-outbox', id: raw.id, depth: 0, overrideAccess: true, req }).catch(() => null)
          return current?.state === 'processing' && current.leaseToken === token && Boolean(outbox)
        })
        if (!stillPresent) continue
        const sent = await sendAreaMail(payload, 'notifications', { sender, recipient: recipient.email, ...message(raw.kind, raw.id) })
        await store.update({ collection: 'notification-deliveries', id: delivery.id, data: { state: 'delivered', leaseToken: null, leaseExpiresAt: null, providerMessageID: sent.messageID, completedAt: new Date().toISOString(), failureCode: null }, overrideAccess: true })
        await updateOutboxState(store, raw)
        return { id: delivery.id, state: 'delivered' }
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        if (code === 'mailbox_not_ready' || code === 'mailbox_not_configured' || code === 'smtp_target_rejected') {
          const current = await store.findByID({ collection: 'notification-deliveries', id: delivery.id, depth: 0, overrideAccess: true }) as { attempts?: number }
          const state = await retryPreSend(store, raw, delivery.id, Number(current.attempts ?? 0), now, code === 'smtp_target_rejected' ? 'smtp-target-rejected' : code === 'mailbox_not_configured' ? 'mailbox-not-configured' : 'mailbox-not-ready')
          return { id: delivery.id, state }
        }
        // SMTP may have accepted bytes before a connection failure. Never resend automatically.
        await store.update({ collection: 'notification-deliveries', id: delivery.id, data: { state: 'unknown', leaseToken: null, leaseExpiresAt: null, failureCode: 'smtp-outcome-unknown', completedAt: new Date().toISOString() }, overrideAccess: true })
        await updateOutboxState(store, raw)
        return { id: delivery.id, state: 'unknown' }
      } finally { /* process-local lease is released by exclusively() */ }
    }
  }
  return null
}
