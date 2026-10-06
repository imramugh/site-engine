import { createHash } from 'node:crypto'
import type { Payload } from 'payload'

const opaque = /^[^\u0000-\u001f\u007f]{1,500}$/
const address = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const providers = new Set(['smtp', 'microsoft', 'google'])
const clean = (value: unknown, limit: number) => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
const addressHash = (value: string) => createHash('sha256').update(value).digest('hex')
const inFlight = new Map<string, Promise<unknown>>()

export type InboundMessage = { mailbox: string; provider: 'smtp' | 'microsoft' | 'google'; conversationID: string; messageID: string; rfcMessageID?: string; rfcReferences?: string; sender: string; recipient: string; subject: string; body: string; receivedAt: string; attachmentMetadata?: Array<{ name?: unknown; contentType?: unknown; size?: unknown }> }
type InboundResult = { matched: false; suggested: boolean } | { matched: true; duplicate: boolean; message: unknown }

/**
 * Appends only to an already-associated provider conversation. Address and
 * subject are deliberately not lookup keys: a new conversation is a staff
 * suggestion, never an automatic lead/application association.
 */
export function appendMatchedInbound(payload: Payload, input: InboundMessage): Promise<InboundResult> {
  const key = `${input.mailbox}\u0000${input.provider}\u0000${input.messageID}`
  const active = inFlight.get(key)
  if (active) return active as Promise<InboundResult>
  const operation = appendMatchedInboundInner(payload, input).finally(() => { if (inFlight.get(key) === operation) inFlight.delete(key) })
  inFlight.set(key, operation)
  return operation as Promise<InboundResult>
}

async function appendMatchedInboundInner(payload: Payload, input: InboundMessage) {
  const mailbox = String(input.mailbox); const conversationID = String(input.conversationID); const messageID = String(input.messageID)
  const sender = clean(input.sender, 320).toLowerCase(); const recipient = clean(input.recipient, 320).toLowerCase()
  if (!opaque.test(mailbox) || !providers.has(input.provider) || !opaque.test(conversationID) || !opaque.test(messageID) || !address.test(sender) || !address.test(recipient) || Number.isNaN(Date.parse(input.receivedAt))) throw new Error('invalid_inbound_message')
  const matched = await payload.find({ collection: 'mail-threads', where: { and: [{ mailbox: { equals: mailbox } }, { provider: { equals: input.provider } }, { providerConversationID: { equals: conversationID } }] }, limit: 1, depth: 0, overrideAccess: true })
  const thread = matched.docs[0]
  if (!thread) {
    const [lead, application] = await Promise.all([
      payload.find({ collection: 'inquiries', where: { and: [{ email: { equals: sender } }, { spam: { not_equals: true } }] }, limit: 1, depth: 0, overrideAccess: true }),
      payload.find({ collection: 'applications', where: { email: { equals: sender } }, limit: 1, depth: 0, overrideAccess: true }),
    ])
    const target = lead.docs[0] ? 'lead' : application.docs[0] ? 'application' : undefined
    if (target) {
      const prior = await payload.find({ collection: 'mail-conversation-suggestions', where: { and: [{ mailbox: { equals: mailbox } }, { provider: { equals: input.provider } }, { providerConversationID: { equals: conversationID } }, { target: { equals: target } }] }, limit: 1, depth: 0, overrideAccess: true })
      if (!prior.docs[0]) await payload.create({ collection: 'mail-conversation-suggestions', data: { mailbox, provider: input.provider, providerConversationID: conversationID, addressHash: addressHash(sender), target }, overrideAccess: true })
    }
    return { matched: false as const, suggested: Boolean(target) }
  }
  const existing = await payload.find({ collection: 'mail-thread-messages', where: { and: [{ mailbox: { equals: mailbox } }, { providerMessageID: { equals: messageID } }] }, limit: 1, depth: 0, overrideAccess: true })
  if (existing.docs[0]) {
    const existingThread = typeof existing.docs[0].thread === 'string' ? existing.docs[0].thread : existing.docs[0].thread?.id
    if (existingThread !== thread.id) throw new Error('provider_message_collision')
    return { matched: true as const, duplicate: true as const, message: existing.docs[0] }
  }
  const attachments = Array.isArray(input.attachmentMetadata) ? input.attachmentMetadata.slice(0, 20).map((attachment) => ({ name: clean(attachment?.name, 200), contentType: clean(attachment?.contentType, 100), size: typeof attachment?.size === 'number' && Number.isSafeInteger(attachment.size) && attachment.size >= 0 ? attachment.size : null })) : []
  const target = typeof thread.lead === 'string' ? { lead: thread.lead } : thread.lead ? { lead: thread.lead.id } : { application: typeof thread.application === 'string' ? thread.application : thread.application?.id }
  try {
    const message = await payload.create({ collection: 'mail-thread-messages', data: { thread: thread.id, mailbox, ...target, providerMessageID: messageID, ...(input.rfcMessageID ? { rfcMessageID: input.rfcMessageID, ...(input.rfcReferences ? { rfcReferences: input.rfcReferences } : {}) } : {}), direction: 'inbound', sender, recipient, subject: clean(input.subject, 500), body: clean(input.body, 20_000), receivedAt: new Date(input.receivedAt).toISOString(), attachmentMetadata: attachments }, depth: 0, overrideAccess: true })
    return { matched: true as const, duplicate: false as const, message }
  } catch {
    const raced = await payload.find({ collection: 'mail-thread-messages', where: { and: [{ mailbox: { equals: mailbox } }, { providerMessageID: { equals: messageID } }] }, limit: 1, depth: 0, overrideAccess: true })
    const message = raced.docs[0]; const racedThread = typeof message?.thread === 'string' ? message.thread : message?.thread?.id
    if (!message || racedThread !== thread.id) throw new Error('provider_message_collision')
    return { matched: true as const, duplicate: true as const, message }
  }
}
