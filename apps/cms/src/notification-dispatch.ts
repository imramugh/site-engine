import { randomUUID } from 'node:crypto'
import type { Payload } from 'payload'
import { sendAreaMail } from './mailboxes'
import { withPayloadTransaction } from './auth-transaction'

type Recipient = { type: 'staff' | 'urgent-contact'; id: string; email: string }
type Outbox = { id: string; kind: string; recipients: Recipient[]; channels: string[] }
const retryDelay = 5 * 60_000
const maxPreSendAttempts = 5
const dispatchLocks = new Map<string, Promise<unknown>>()

function message(kind: string, id: string) {
  const label: Record<string, string> = { 'new-lead': 'New lead', 'active-incident-lead': 'Active incident lead', 'new-job-application': 'New job application', 'change-set-submitted': 'Change set submitted', 'publish-or-integration-failed': 'Publish or integration failure' }
  return { subject: `${label[kind] ?? 'Operations notification'} (${id})`, body: `An operations event requires review.\n\nEvent: ${kind}\nReference: ${id}\nOpen: /operations\n` }
}
function key(outbox: string, recipient: Recipient, channel: string) { return `${outbox}:${recipient.type}:${recipient.id}:${channel}` }

/** Executes at most one recipient delivery. Call only from an internal worker. */
export async function dispatchOneNotification(payload: Payload, now = new Date()): Promise<{ id: string; state: string } | null> {
  // payload-types are generated at image build; retain local compatibility for
  // this newly migrated collection before that generation step.
  const store = payload as any
  const outboxes = await store.find({ collection: 'notification-outbox', where: { state: { equals: 'queued' } }, limit: 25, pagination: false, depth: 0, overrideAccess: true })
  for (const raw of outboxes.docs as unknown as Outbox[]) {
    for (const recipient of raw.recipients ?? []) for (const channel of raw.channels ?? []) {
      const idempotencyKey = key(raw.id, recipient, channel)
      const existing = await store.find({ collection: 'notification-deliveries', where: { idempotencyKey: { equals: idempotencyKey } }, limit: 1, depth: 0, overrideAccess: true })
      let delivery = existing.docs[0] as { id: string; state: string; nextAttemptAt?: string; leaseExpiresAt?: string } | undefined
      if (!delivery) {
        try { delivery = await store.create({ collection: 'notification-deliveries', data: { outbox: raw.id, idempotencyKey, recipient, state: channel === 'email' ? 'queued' : 'unsupported', attempts: 0, nextAttemptAt: now.toISOString(), ...(channel === 'email' ? {} : { failureCode: 'channel-unsupported', completedAt: now.toISOString() }) }, overrideAccess: true }) as typeof delivery }
        catch { delivery = (await store.find({ collection: 'notification-deliveries', where: { idempotencyKey: { equals: idempotencyKey } }, limit: 1, depth: 0, overrideAccess: true })).docs[0] as typeof delivery }
      }
      if (!delivery || !['queued', 'retryable'].includes(delivery.state) || (delivery.nextAttemptAt && new Date(delivery.nextAttemptAt) > now) || (delivery.leaseExpiresAt && new Date(delivery.leaseExpiresAt) > now)) continue
      if (dispatchLocks.has(delivery.id)) continue
      const token = randomUUID()
      const claimed = await withPayloadTransaction(payload, async req => {
        const current = await store.findByID({ collection: 'notification-deliveries', id: delivery!.id, depth: 0, overrideAccess: true, req }) as { state: string; nextAttemptAt: string; leaseExpiresAt?: string; attempts?: number }
        if (!['queued', 'retryable'].includes(current.state) || new Date(current.nextAttemptAt) > now || (current.leaseExpiresAt && new Date(current.leaseExpiresAt) > now)) return false
        await store.update({ collection: 'notification-deliveries', id: delivery!.id, data: { state: 'processing', attempts: Number(current.attempts ?? 0) + 1, leaseToken: token, leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString() }, overrideAccess: true, req })
        return true
      })
      if (!claimed) continue
      const mapping = await payload.find({ collection: 'mailbox-area-mappings', where: { area: { equals: 'notifications' } }, limit: 1, depth: 0, overrideAccess: true })
      if (!mapping.docs[0]) { await store.update({ collection: 'notification-deliveries', id: delivery.id, data: { state: 'queued', leaseToken: null, leaseExpiresAt: null, nextAttemptAt: new Date(now.getTime() + retryDelay).toISOString(), failureCode: 'mailbox-not-configured' }, overrideAccess: true }); return { id: delivery.id, state: 'queued' } }
      const sender = String(mapping.docs[0].senderAddress)
      const active = Promise.resolve(); dispatchLocks.set(delivery.id, active)
      try {
        const sent = await sendAreaMail(payload, 'notifications', { sender, recipient: recipient.email, ...message(raw.kind, raw.id) })
        await store.update({ collection: 'notification-deliveries', id: delivery.id, data: { state: 'delivered', leaseToken: null, leaseExpiresAt: null, providerMessageID: sent.messageID, completedAt: new Date().toISOString(), failureCode: null }, overrideAccess: true })
        return { id: delivery.id, state: 'delivered' }
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        if (code === 'mailbox_not_ready' || code === 'mailbox_not_configured') {
          const current = await store.findByID({ collection: 'notification-deliveries', id: delivery.id, depth: 0, overrideAccess: true }) as { attempts?: number }
          const exhausted = Number(current.attempts ?? 0) >= maxPreSendAttempts
          await store.update({ collection: 'notification-deliveries', id: delivery.id, data: exhausted ? { state: 'failed', leaseToken: null, leaseExpiresAt: null, failureCode: 'mailbox-not-ready', completedAt: new Date().toISOString() } : { state: 'retryable', leaseToken: null, leaseExpiresAt: null, nextAttemptAt: new Date(now.getTime() + retryDelay).toISOString(), failureCode: 'mailbox-not-ready' }, overrideAccess: true })
          return { id: delivery.id, state: exhausted ? 'failed' : 'retryable' }
        }
        // SMTP may have accepted bytes before a connection failure. Never resend automatically.
        await store.update({ collection: 'notification-deliveries', id: delivery.id, data: { state: 'unknown', leaseToken: null, leaseExpiresAt: null, failureCode: 'smtp-outcome-unknown', completedAt: new Date().toISOString() }, overrideAccess: true })
        return { id: delivery.id, state: 'unknown' }
      } finally { dispatchLocks.delete(delivery.id) }
    }
  }
  return null
}
