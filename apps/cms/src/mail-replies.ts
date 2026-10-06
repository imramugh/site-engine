import { randomUUID } from 'node:crypto'
import type { Payload } from 'payload'
import { authorizeMailDraft, cancelPreparedMailDraft, consumeMailAuthorization, revokeMailAuthorization } from './mail-authorizations'
import { sendAreaMail } from './mailboxes'
import { withPayloadTransaction } from './auth-transaction'
import { assertLeadAcceptsOutbound } from './lead-outbound'

let replyDelivery = sendAreaMail
export function setReplyDeliveryForTest(sender?: typeof sendAreaMail) { if (process.env.NODE_ENV !== 'test') throw new Error('Test delivery override is disabled.'); replyDelivery = sender ?? sendAreaMail }

/** Created only from a validated MCP introspection result; HTTP callers never
 * provide these identity fields. */
export type AssistantReplyOrigin = { clientIDHash: string; actorID: string; oauthSessionID: string }

const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function sanitizeMailBody(value: unknown) { if (typeof value !== 'string') throw new Error('invalid_reply'); const body = value.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim(); if (!body || body.length > 10_000) throw new Error('invalid_reply'); return body }
export async function prepareReply(payload: Payload, target: 'lead' | 'application', targetID: string, actor: string, input: { sender: unknown; subject: unknown; body: unknown; threadID?: unknown }, assistantOrigin?: AssistantReplyOrigin) {
  const recipientDoc = await payload.findByID({ collection: target === 'lead' ? 'inquiries' : 'applications', id: targetID, depth: 0, overrideAccess: true }) as { email?: string }
  if (target === 'lead') await assertLeadAcceptsOutbound(payload, targetID)
  const sender = typeof input.sender === 'string' ? input.sender.trim().toLowerCase() : ''; const subject = typeof input.subject === 'string' ? input.subject.trim() : ''
  if (!email.test(sender) || !email.test(String(recipientDoc.email ?? '')) || !subject || subject.length > 200 || /[\u0000-\u001f\u007f]/.test(sender + String(recipientDoc.email ?? '') + subject)) throw new Error('invalid_reply')
  return withPayloadTransaction(payload, async (req) => { const draft = await payload.create({ collection: 'mail-drafts', data: { [target]: targetID, threadID: typeof input.threadID === 'string' && input.threadID.trim() ? input.threadID.trim().slice(0, 500) : randomUUID(), recipient: String(recipientDoc.email).toLowerCase(), sender, subject, body: sanitizeMailBody(input.body), attachmentHashes: [], revision: 1, state: 'prepared', ...(assistantOrigin ? { assistantClientIDHash: assistantOrigin.clientIDHash, assistantActor: assistantOrigin.actorID, assistantOAuthSessionID: assistantOrigin.oauthSessionID } : {}) } as never, overrideAccess: true, req }); await payload.create({ collection: 'audit-events', data: { event: 'mail.reply_prepared', user: actor, actor, detail: { draft: draft.id, target, targetID, ...(assistantOrigin ? { clientIdHash: assistantOrigin.clientIDHash, originOAuthSessionID: assistantOrigin.oauthSessionID } : {}) } }, overrideAccess: true, req }); return draft })
}
export async function authorizeReply(payload: Payload, actor: { id: string; sessionToken?: string }, draftID: string) { return authorizeMailDraft(payload, actor, draftID, new Date(Date.now() + 10 * 60_000)) }
export async function cancelReply(payload: Payload, actor: { id: string; sessionToken?: string }, grantID: string) { return revokeMailAuthorization(payload, actor, grantID) }
export async function cancelPreparedReply(payload: Payload, actor: { id: string; sessionToken?: string }, draftID: string) { return cancelPreparedMailDraft(payload, actor, draftID) }
export async function sendReply(payload: Payload, actor: { id: string; sessionToken?: string }, grantID: string) {
  const pending = await payload.findByID({ collection: 'mail-authorizations', id: grantID, depth: 0, overrideAccess: true })
  const pendingDraft = await payload.findByID({ collection: 'mail-drafts', id: typeof pending.draft === 'string' ? pending.draft : pending.draft.id, depth: 0, overrideAccess: true })
  if (Array.isArray(pendingDraft.attachmentHashes) && pendingDraft.attachmentHashes.length) throw new Error('reply_attachments_not_supported')
  const pendingApplication = pendingDraft.application && (typeof pendingDraft.application === 'string' ? pendingDraft.application : pendingDraft.application.id)
  const target = { collection: pendingApplication ? 'applications' as const : 'inquiries' as const, id: String(pendingApplication || pendingDraft.lead) }
  const area = pendingApplication ? 'careers' : 'leads'
  const mapping = await payload.find({ collection: 'mailbox-area-mappings', where: { area: { equals: area } }, limit: 1, depth: 0, overrideAccess: true })
  const mailboxID = mapping.docs[0] && (typeof mapping.docs[0].mailbox === 'string' ? mapping.docs[0].mailbox : mapping.docs[0].mailbox.id)
  const mailbox = mailboxID ? await payload.findByID({ collection: 'mailbox-configurations', id: mailboxID, depth: 0, overrideAccess: true }) : undefined
  let providerReply: { providerThreadID: string; providerMessageID: string; providerMailboxID: string; provider: 'microsoft' | 'google'; providerTarget: { collection: 'inquiries' | 'applications'; id: string }; providerRFCMessageID?: string; providerRFCReferences?: string; providerSubject: string } | undefined
  let initialProvider: { provider: 'microsoft' | 'google'; mailboxID: string; rfcMessageID?: string } | undefined
  if (mailbox && (mailbox.provider === 'microsoft' || mailbox.provider === 'google')) {
    const thread = await payload.find({ collection: 'mail-threads', where: { and: [{ [pendingApplication ? 'application' : 'lead']: { equals: target.id } }, { mailbox: { equals: mailboxID } }, { provider: { equals: mailbox.provider } }, { providerConversationID: { equals: String(pendingDraft.threadID) } }] }, limit: 1, depth: 0, overrideAccess: true })
    if (!thread.docs[0]) {
      const domain = String(pendingDraft.sender).split('@')[1]
      initialProvider = { provider: mailbox.provider, mailboxID, ...(mailbox.provider === 'google' && domain ? { rfcMessageID: `<${randomUUID()}@${domain}>` } : {}) }
    } else {
      const messages = await payload.find({ collection: 'mail-thread-messages', where: { thread: { equals: thread.docs[0].id } }, sort: '-receivedAt', limit: 1, depth: 0, overrideAccess: true })
      if (!messages.docs[0]?.providerMessageID || (mailbox.provider === 'google' && (!messages.docs[0].rfcMessageID || String(messages.docs[0].subject) !== String(pendingDraft.subject)))) throw new Error('mailbox_thread_not_grounded')
      providerReply = { providerThreadID: String(thread.docs[0].providerConversationID), providerMessageID: String(messages.docs[0].providerMessageID), providerMailboxID: mailboxID, provider: mailbox.provider, providerTarget: target, ...(mailbox.provider === 'google' ? { providerRFCMessageID: String(messages.docs[0].rfcMessageID), ...(messages.docs[0].rfcReferences ? { providerRFCReferences: String(messages.docs[0].rfcReferences) } : {}) } : {}), providerSubject: String(messages.docs[0].subject) }
    }
  }
  const grant = await consumeMailAuthorization(payload, actor, grantID)
  const draftID = typeof grant.draft === 'string' ? grant.draft : grant.draft.id
  const draft = grant.envelope
  try {
    const delivered = await replyDelivery(payload, area, {
      sender: String(draft.sender), recipient: String(draft.recipient), subject: String(draft.subject), body: String(draft.body),
      ...(providerReply ? { threadID: String(draft.threadID), ...providerReply } : {}),
      ...(initialProvider ? { initialOutbound: true, outboundRFCMessageID: initialProvider.rfcMessageID } : {}),
    })
    if (initialProvider) {
      if (delivered.provider !== initialProvider.provider || !('threadID' in delivered) || !delivered.threadID || !delivered.messageID) throw new Error('provider_malformed_response')
      const persistedThread = await payload.create({ collection: 'mail-threads', data: { [pendingApplication ? 'application' : 'lead']: target.id, mailbox: initialProvider.mailboxID, provider: initialProvider.provider, providerConversationID: delivered.threadID } as never, overrideAccess: true })
      await payload.create({ collection: 'mail-thread-messages', data: { thread: persistedThread.id, mailbox: initialProvider.mailboxID, [pendingApplication ? 'application' : 'lead']: target.id, providerMessageID: delivered.messageID, ...(initialProvider.rfcMessageID ? { rfcMessageID: initialProvider.rfcMessageID } : {}), direction: 'outbound', sender: String(draft.sender), recipient: String(draft.recipient), subject: String(draft.subject), body: String(draft.body), receivedAt: new Date().toISOString(), attachmentMetadata: [] } as never, overrideAccess: true })
    }
    await payload.update({ collection: 'mail-drafts', id: draftID, data: { state: 'sent' }, overrideAccess: true })
    await payload.create({ collection: 'audit-events', data: { event: 'mail.reply_sent', user: actor.id, actor: actor.id, detail: { draft: draftID, grant: grantID, provider: delivered.provider, messageID: delivered.messageID } }, overrideAccess: true })
    return delivered
  } catch (error) {
    await payload.update({ collection: 'mail-drafts', id: draftID, data: { state: 'delivery-unknown' }, overrideAccess: true })
    await payload.create({ collection: 'audit-events', data: { event: 'mail.reply_delivery_unknown', user: actor.id, actor: actor.id, detail: { draft: draftID, grant: grantID } }, overrideAccess: true })
    throw error
  }
}
