import { randomUUID } from 'node:crypto'
import type { Payload } from 'payload'
import { authorizeMailDraft, cancelPreparedMailDraft, consumeMailAuthorization, consumeMcpMailAuthorization, revokeMailAuthorization, type McpMailIdentity } from './mail-authorizations'
import { assertAreaAttachmentDelivery, sendAreaMail } from './mailboxes'
import { withPayloadTransaction } from './auth-transaction'
import { assertLeadAcceptsOutbound } from './lead-outbound'
import { resolveOutgoingAttachments, resolveVerifiedOutgoingAttachments, type VerifiedOutgoingAttachment } from './outgoing-attachments'
import { boundedRFCReferenceChain } from './mail-provider-adapters'

let replyDelivery = sendAreaMail
export function setReplyDeliveryForTest(sender?: typeof sendAreaMail) { if (process.env.NODE_ENV !== 'test') throw new Error('Test delivery override is disabled.'); replyDelivery = sender ?? sendAreaMail }

/** Created only from a validated MCP introspection result; HTTP callers never
 * provide these identity fields. */
export type AssistantReplyOrigin = { clientIDHash: string; actorID: string; oauthSessionID: string }

const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function sanitizeMailBody(value: unknown) { if (typeof value !== 'string') throw new Error('invalid_reply'); const body = value.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim(); if (!body || body.length > 10_000) throw new Error('invalid_reply'); return body }
export async function prepareReply(payload: Payload, target: 'lead' | 'application', targetID: string, actor: string, input: { sender: unknown; subject: unknown; body: unknown; threadID?: unknown; attachments?: unknown }, assistantOrigin?: AssistantReplyOrigin) {
  const recipientDoc = await payload.findByID({ collection: target === 'lead' ? 'inquiries' : 'applications', id: targetID, depth: 0, overrideAccess: true }) as { email?: string }
  if (target === 'lead') await assertLeadAcceptsOutbound(payload, targetID)
  const sender = typeof input.sender === 'string' ? input.sender.trim().toLowerCase() : ''; const subject = typeof input.subject === 'string' ? input.subject.trim() : ''
  if (!email.test(sender) || !email.test(String(recipientDoc.email ?? '')) || !subject || subject.length > 200 || /[\u0000-\u001f\u007f]/.test(sender + String(recipientDoc.email ?? '') + subject)) throw new Error('invalid_reply')
  const attachments = await resolveOutgoingAttachments(payload, { target, targetID, actorID: actor, attachments: input.attachments })
  return withPayloadTransaction(payload, async (req) => { const draft = await payload.create({ collection: 'mail-drafts', data: { [target]: targetID, threadID: typeof input.threadID === 'string' && input.threadID.trim() ? input.threadID.trim().slice(0, 500) : randomUUID(), recipient: String(recipientDoc.email).toLowerCase(), sender, subject, body: sanitizeMailBody(input.body), attachments, attachmentHashes: attachments.map((attachment) => attachment.sha256), revision: 1, state: 'prepared', ...(assistantOrigin ? { assistantClientIDHash: assistantOrigin.clientIDHash, assistantActor: assistantOrigin.actorID, assistantOAuthSessionID: assistantOrigin.oauthSessionID } : {}) } as never, overrideAccess: true, req }); await payload.create({ collection: 'audit-events', data: { event: 'mail.reply_prepared', user: actor, actor, detail: { draft: draft.id, target, targetID, ...(assistantOrigin ? { clientIdHash: assistantOrigin.clientIDHash, originOAuthSessionID: assistantOrigin.oauthSessionID } : {}) } }, overrideAccess: true, req }); return draft })
}
async function verifyDraftAttachments(payload: Payload, actorID: string, draftID: string) {
  const draft = await payload.findByID({ collection: 'mail-drafts', id: draftID, depth: 0, overrideAccess: true }) as { lead?: unknown; application?: unknown; attachments?: unknown; attachmentHashes?: unknown }
  const application = typeof draft.application === 'string' ? draft.application : (draft.application as { id?: string } | undefined)?.id
  const target = application ? 'application' as const : 'lead' as const
  const targetID = String(application ?? (typeof draft.lead === 'string' ? draft.lead : (draft.lead as { id?: string } | undefined)?.id ?? ''))
  const stored = Array.isArray(draft.attachments) ? draft.attachments : []
  const resolved = await resolveVerifiedOutgoingAttachments(payload, { target, targetID, actorID, attachments: stored.map((attachment) => ({ source: (attachment as { source?: unknown }).source, id: (attachment as { sourceID?: unknown }).sourceID })) })
  const descriptors = resolved.map(({ bytes: _bytes, ...attachment }) => attachment)
  if (JSON.stringify(descriptors) !== JSON.stringify(stored) || JSON.stringify(descriptors.map((attachment) => attachment.sha256).sort()) !== JSON.stringify((Array.isArray(draft.attachmentHashes) ? draft.attachmentHashes.map(String) : []).sort())) throw new Error('attachment_not_available')
  return resolved
}
export async function authorizeReply(payload: Payload, actor: { id: string; sessionToken?: string }, draftID: string) { await verifyDraftAttachments(payload, actor.id, draftID); return authorizeMailDraft(payload, actor, draftID, new Date(Date.now() + 10 * 60_000)) }
export async function cancelReply(payload: Payload, actor: { id: string; sessionToken?: string }, grantID: string) { return revokeMailAuthorization(payload, actor, grantID) }
export async function cancelPreparedReply(payload: Payload, actor: { id: string; sessionToken?: string }, draftID: string) { return cancelPreparedMailDraft(payload, actor, draftID) }
async function deliverReply(payload: Payload, actorID: string, grantID: string, grant: any, attachments: readonly VerifiedOutgoingAttachment[] = []) {
  const draftID = typeof grant.draft === 'string' ? grant.draft : grant.draft.id
  try {
  const pending = await payload.findByID({ collection: 'mail-authorizations', id: grantID, depth: 0, overrideAccess: true })
  const pendingDraft = await payload.findByID({ collection: 'mail-drafts', id: typeof pending.draft === 'string' ? pending.draft : pending.draft.id, depth: 0, overrideAccess: true })
  const pendingApplication = pendingDraft.application && (typeof pendingDraft.application === 'string' ? pendingDraft.application : pendingDraft.application.id)
  const target = { collection: pendingApplication ? 'applications' as const : 'inquiries' as const, id: String(pendingApplication || pendingDraft.lead) }
  const area = pendingApplication ? 'careers' : 'leads'
  const mapping = await payload.find({ collection: 'mailbox-area-mappings', where: { area: { equals: area } }, limit: 1, depth: 0, overrideAccess: true })
  const mailboxID = mapping.docs[0] && (typeof mapping.docs[0].mailbox === 'string' ? mapping.docs[0].mailbox : mapping.docs[0].mailbox.id)
  const mailbox = mailboxID ? await payload.findByID({ collection: 'mailbox-configurations', id: mailboxID, depth: 0, overrideAccess: true }) : undefined
  let providerReply: { providerThreadID: string; providerMessageID: string; providerMailboxID: string; provider: 'microsoft' | 'google'; providerTarget: { collection: 'inquiries' | 'applications'; id: string }; providerRFCMessageID?: string; providerRFCReferences?: string; outboundRFCMessageID?: string; outboundRFCReferences?: string; providerSubject: string } | undefined
  let persistedReplyThread: { id: string; mailboxID: string; provider: 'microsoft' | 'google'; targetField: 'lead' | 'application'; targetID: string } | undefined
  const smtpTimeline = mailbox?.provider === 'smtp' ? { mailboxID: String(mailboxID), targetField: pendingApplication ? 'application' as const : 'lead' as const, targetID: target.id, draftThreadID: String(pendingDraft.threadID) } : undefined
  let initialProvider: { provider: 'microsoft' | 'google'; mailboxID: string; rfcMessageID?: string } | undefined
  if (mailbox && (mailbox.provider === 'microsoft' || mailbox.provider === 'google')) {
    const thread = await payload.find({ collection: 'mail-threads', where: { and: [{ [pendingApplication ? 'application' : 'lead']: { equals: target.id } }, { mailbox: { equals: mailboxID } }, { provider: { equals: mailbox.provider } }, { providerConversationID: { equals: String(pendingDraft.threadID) } }] }, limit: 1, depth: 0, overrideAccess: true })
    if (!thread.docs[0]) {
      const domain = String(pendingDraft.sender).split('@')[1]
      initialProvider = { provider: mailbox.provider, mailboxID, ...(mailbox.provider === 'google' && domain ? { rfcMessageID: `<${randomUUID()}@${domain}>` } : {}) }
    } else {
      const messages = await payload.find({ collection: 'mail-thread-messages', where: { thread: { equals: thread.docs[0].id } }, sort: '-receivedAt', limit: 1, depth: 0, overrideAccess: true })
      if (!messages.docs[0]?.providerMessageID || (mailbox.provider === 'google' && (!messages.docs[0].rfcMessageID || String(messages.docs[0].subject) !== String(pendingDraft.subject)))) throw new Error('mailbox_thread_not_grounded')
      const inboundRFCMessageID = String(messages.docs[0].rfcMessageID)
      const outboundRFCMessageID = mailbox.provider === 'google' ? `<${randomUUID()}@${String(pendingDraft.sender).split('@')[1]}>` : undefined
      const outboundRFCReferences = mailbox.provider === 'google' ? boundedRFCReferenceChain(messages.docs[0].rfcReferences, inboundRFCMessageID) : undefined
      providerReply = { providerThreadID: String(thread.docs[0].providerConversationID), providerMessageID: String(messages.docs[0].providerMessageID), providerMailboxID: mailboxID, provider: mailbox.provider, providerTarget: target, ...(mailbox.provider === 'google' ? { providerRFCMessageID: inboundRFCMessageID, ...(messages.docs[0].rfcReferences ? { providerRFCReferences: String(messages.docs[0].rfcReferences) } : {}), outboundRFCMessageID, ...(outboundRFCReferences ? { outboundRFCReferences } : {}) } : {}), providerSubject: String(messages.docs[0].subject) }
      persistedReplyThread = { id: String(thread.docs[0].id), mailboxID, provider: mailbox.provider, targetField: pendingApplication ? 'application' : 'lead', targetID: target.id }
    }
  }
  const draft = grant.envelope
    const delivered = await replyDelivery(payload, area, {
      sender: String(draft.sender), recipient: String(draft.recipient), subject: String(draft.subject), body: String(draft.body),
      ...(providerReply ? { threadID: String(draft.threadID), ...providerReply } : {}),
      ...(providerReply?.outboundRFCMessageID ? { outboundRFCMessageID: providerReply.outboundRFCMessageID } : {}),
      ...(initialProvider ? { initialOutbound: true, outboundRFCMessageID: initialProvider.rfcMessageID } : {}),
      ...(attachments.length ? { attachments } : {}),
    })
    if (initialProvider) {
      if (delivered.provider !== initialProvider.provider || !('threadID' in delivered) || !delivered.threadID || !delivered.messageID) throw new Error('provider_malformed_response')
      const persistedThread = await payload.create({ collection: 'mail-threads', data: { [pendingApplication ? 'application' : 'lead']: target.id, mailbox: initialProvider.mailboxID, provider: initialProvider.provider, providerConversationID: delivered.threadID } as never, overrideAccess: true })
      await payload.create({ collection: 'mail-thread-messages', data: { thread: persistedThread.id, mailbox: initialProvider.mailboxID, [pendingApplication ? 'application' : 'lead']: target.id, providerMessageID: delivered.messageID, ...(initialProvider.rfcMessageID ? { rfcMessageID: initialProvider.rfcMessageID } : {}), direction: 'outbound', sender: String(draft.sender), recipient: String(draft.recipient), subject: String(draft.subject), body: String(draft.body), receivedAt: new Date().toISOString(), attachmentMetadata: [] } as never, overrideAccess: true })
    }
    if (providerReply && persistedReplyThread) {
      if (delivered.provider !== persistedReplyThread.provider || typeof delivered.messageID !== 'string' || !delivered.messageID) throw new Error('provider_malformed_response')
      const recorded = await payload.find({ collection: 'mail-thread-messages', where: { and: [{ thread: { equals: persistedReplyThread.id } }, { mailbox: { equals: persistedReplyThread.mailboxID } }, { providerMessageID: { equals: delivered.messageID } }] }, limit: 1, depth: 0, overrideAccess: true })
      if (!recorded.docs[0]) await payload.create({ collection: 'mail-thread-messages', data: { thread: persistedReplyThread.id, mailbox: persistedReplyThread.mailboxID, [persistedReplyThread.targetField]: persistedReplyThread.targetID, providerMessageID: delivered.messageID, ...(providerReply.outboundRFCMessageID ? { rfcMessageID: providerReply.outboundRFCMessageID } : {}), ...(providerReply.outboundRFCReferences ? { rfcReferences: providerReply.outboundRFCReferences } : {}), direction: 'outbound', sender: String(draft.sender), recipient: String(draft.recipient), subject: String(draft.subject), body: String(draft.body), receivedAt: new Date().toISOString(), attachmentMetadata: [] } as never, overrideAccess: true })
    }
    if (smtpTimeline) {
      if (delivered.provider !== 'smtp' || typeof delivered.messageID !== 'string' || !delivered.messageID) throw new Error('provider_malformed_response')
      const existingThread = await payload.find({ collection: 'mail-threads', where: { and: [{ [smtpTimeline.targetField]: { equals: smtpTimeline.targetID } }, { mailbox: { equals: smtpTimeline.mailboxID } }, { provider: { equals: 'smtp' } }, { providerConversationID: { equals: smtpTimeline.draftThreadID } }] }, limit: 1, depth: 0, overrideAccess: true })
      const persistedThread = existingThread.docs[0] ?? await payload.create({ collection: 'mail-threads', data: { [smtpTimeline.targetField]: smtpTimeline.targetID, mailbox: smtpTimeline.mailboxID, provider: 'smtp', providerConversationID: smtpTimeline.draftThreadID } as never, overrideAccess: true })
      const recorded = await payload.find({ collection: 'mail-thread-messages', where: { and: [{ thread: { equals: persistedThread.id } }, { mailbox: { equals: smtpTimeline.mailboxID } }, { providerMessageID: { equals: delivered.messageID } }] }, limit: 1, depth: 0, overrideAccess: true })
      if (!recorded.docs[0]) await payload.create({ collection: 'mail-thread-messages', data: { thread: persistedThread.id, mailbox: smtpTimeline.mailboxID, [smtpTimeline.targetField]: smtpTimeline.targetID, providerMessageID: delivered.messageID, direction: 'outbound', sender: String(draft.sender), recipient: String(draft.recipient), subject: String(draft.subject), body: String(draft.body), receivedAt: new Date().toISOString(), attachmentMetadata: [] } as never, overrideAccess: true })
    }
    await payload.update({ collection: 'mail-drafts', id: draftID, data: { state: 'sent' }, overrideAccess: true })
    await payload.create({ collection: 'audit-events', data: { event: 'mail.reply_sent', user: actorID, actor: actorID, detail: { draft: draftID, grant: grantID, provider: delivered.provider, messageID: delivered.messageID, ...(typeof draft.assistantClientIDHash === 'string' ? { clientIdHash: draft.assistantClientIDHash } : {}) } }, overrideAccess: true })
    return delivered
  } catch (error) {
    await payload.update({ collection: 'mail-drafts', id: draftID, data: { state: 'delivery-unknown' }, overrideAccess: true })
    await payload.create({ collection: 'audit-events', data: { event: 'mail.reply_delivery_unknown', user: actorID, actor: actorID, detail: { draft: draftID, grant: grantID, ...(typeof grant.envelope?.assistantClientIDHash === 'string' ? { clientIdHash: grant.envelope.assistantClientIDHash } : {}) } }, overrideAccess: true })
    throw error
  }
}
export async function sendReply(payload: Payload, actor: { id: string; sessionToken?: string }, grantID: string) {
  const attachments = await verifiedGrantAttachments(payload, actor.id, grantID)
  if (attachments.items.length) await assertAreaAttachmentDelivery(payload, attachments.area, attachments.items)
  return deliverReply(payload, actor.id, grantID, await consumeMailAuthorization(payload, actor, grantID), attachments.items)
}
export async function sendMcpReply(payload: Payload, identity: McpMailIdentity, grantID: string) {
  const attachments = await verifiedGrantAttachments(payload, identity.userID, grantID)
  if (attachments.items.length) await assertAreaAttachmentDelivery(payload, attachments.area, attachments.items)
  return deliverReply(payload, identity.userID, grantID, await consumeMcpMailAuthorization(payload, identity, grantID), attachments.items)
}
async function verifiedGrantAttachments(payload: Payload, actorID: string, grantID: string) {
  const grant = await payload.findByID({ collection: 'mail-authorizations', id: grantID, depth: 0, overrideAccess: true })
  const draftID = typeof grant.draft === 'string' ? grant.draft : grant.draft.id
  const draft = await payload.findByID({ collection: 'mail-drafts', id: draftID, depth: 0, overrideAccess: true }) as { application?: unknown; attachments?: unknown; attachmentHashes?: unknown }
  if ((!Array.isArray(draft.attachments) || !draft.attachments.length) && Array.isArray(draft.attachmentHashes) && draft.attachmentHashes.length) throw new Error('reply_attachments_not_supported')
  const items = await verifyDraftAttachments(payload, actorID, String(draftID))
  return { items, area: draft.application ? 'careers' as const : 'leads' as const }
}
