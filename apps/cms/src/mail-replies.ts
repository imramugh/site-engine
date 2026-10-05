import { randomUUID } from 'node:crypto'
import type { Payload } from 'payload'
import { authorizeMailDraft, consumeMailAuthorization, revokeMailAuthorization } from './mail-authorizations'
import { sendAreaMail } from './mailboxes'
import { withPayloadTransaction } from './auth-transaction'
import { assertLeadAcceptsOutbound } from './lead-outbound'

let replyDelivery = sendAreaMail
export function setReplyDeliveryForTest(sender?: typeof sendAreaMail) { if (process.env.NODE_ENV !== 'test') throw new Error('Test delivery override is disabled.'); replyDelivery = sender ?? sendAreaMail }

const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function sanitizeMailBody(value: unknown) { if (typeof value !== 'string') throw new Error('invalid_reply'); const body = value.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim(); if (!body || body.length > 10_000) throw new Error('invalid_reply'); return body }
export async function prepareReply(payload: Payload, target: 'lead' | 'application', targetID: string, actor: string, input: { sender: unknown; subject: unknown; body: unknown; threadID?: unknown }) {
  const recipientDoc = await payload.findByID({ collection: target === 'lead' ? 'inquiries' : 'applications', id: targetID, depth: 0, overrideAccess: true }) as { email?: string }
  if (target === 'lead') await assertLeadAcceptsOutbound(payload, targetID)
  const sender = typeof input.sender === 'string' ? input.sender.trim().toLowerCase() : ''; const subject = typeof input.subject === 'string' ? input.subject.trim() : ''
  if (!email.test(sender) || !email.test(String(recipientDoc.email ?? '')) || !subject || subject.length > 200) throw new Error('invalid_reply')
  return withPayloadTransaction(payload, async (req) => { const draft = await payload.create({ collection: 'mail-drafts', data: { [target]: targetID, threadID: typeof input.threadID === 'string' && input.threadID.trim() ? input.threadID.trim().slice(0, 500) : randomUUID(), recipient: String(recipientDoc.email).toLowerCase(), sender, subject, body: sanitizeMailBody(input.body), attachmentHashes: [], revision: 1, state: 'prepared' } as never, overrideAccess: true, req }); await payload.create({ collection: 'audit-events', data: { event: 'mail.reply_prepared', user: actor, actor, detail: { draft: draft.id, target, targetID } }, overrideAccess: true, req }); return draft })
}
export async function authorizeReply(payload: Payload, actor: { id: string; sessionToken?: string }, draftID: string) { return authorizeMailDraft(payload, actor, draftID, new Date(Date.now() + 10 * 60_000)) }
export async function cancelReply(payload: Payload, actor: { id: string; sessionToken?: string }, grantID: string) { return revokeMailAuthorization(payload, actor, grantID) }
export async function sendReply(payload: Payload, actor: { id: string; sessionToken?: string }, grantID: string) {
  const grant = await consumeMailAuthorization(payload, actor, grantID)
  const draftID = typeof grant.draft === 'string' ? grant.draft : grant.draft.id
  const draft = grant.envelope
  const application = draft.application
  try { const delivered = await replyDelivery(payload, application ? 'careers' : 'leads', { sender: String(draft.sender), recipient: String(draft.recipient), subject: String(draft.subject), body: String(draft.body), threadID: String(draft.threadID) }); await payload.update({ collection: 'mail-drafts', id: draftID, data: { state: 'sent' }, overrideAccess: true }); await payload.create({ collection: 'audit-events', data: { event: 'mail.reply_sent', user: actor.id, actor: actor.id, detail: { draft: draftID, grant: grantID, provider: delivered.provider, messageID: delivered.messageID } }, overrideAccess: true }); return delivered } catch (error) { await payload.update({ collection: 'mail-drafts', id: draftID, data: { state: 'delivery-unknown' }, overrideAccess: true }); await payload.create({ collection: 'audit-events', data: { event: 'mail.reply_delivery_unknown', user: actor.id, actor: actor.id, detail: { draft: draftID, grant: grantID } }, overrideAccess: true }); throw error }
}
