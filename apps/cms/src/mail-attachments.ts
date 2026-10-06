import type { Payload } from 'payload'
import { gmailAttachment, microsoftAttachment, type Fetcher } from './mail-provider-adapters'
import { refreshAndPersistMailboxOAuth } from './mailbox-oauth'

const opaque = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value)
const contentType = (value: unknown) => typeof value === 'string' && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value) ? value.toLowerCase() : 'application/octet-stream'
const filename = (value: unknown) => String(value ?? 'attachment').replace(/[\u0000-\u001f\u007f"\\/]/g, '_').trim().slice(0, 160) || 'attachment'

/**
 * Retrieves one persisted attachment reference through a fixed provider API.
 * Callers must already have checked record-scoped access; this function checks
 * the message belongs to that same selected record before a provider request.
 */
export async function downloadMatchedMailAttachment(payload: Payload, input: { target: 'lead' | 'application'; targetID: string; messageID: string; attachment: number }, fetcher: Fetcher = fetch) {
  if (!Number.isSafeInteger(input.attachment) || input.attachment < 0 || input.attachment >= 20) throw new Error('attachment_not_found')
  const message = await payload.find({ collection: 'mail-thread-messages', where: { and: [{ id: { equals: input.messageID } }, { [input.target]: { equals: input.targetID } }] }, limit: 1, depth: 0, overrideAccess: true })
  const record = message.docs[0] as unknown as Record<string, unknown> | undefined
  if (!record) throw new Error('attachment_not_found')
  const metadata = Array.isArray(record.attachmentMetadata) ? record.attachmentMetadata[input.attachment] as Record<string, unknown> | undefined : undefined
  const attachmentID = metadata?.providerAttachmentID
  const mailboxID = typeof record.mailbox === 'string' ? record.mailbox : (record.mailbox as { id?: string } | undefined)?.id
  if (!opaque(attachmentID) || !opaque(mailboxID) || !opaque(record.providerMessageID)) throw new Error('attachment_not_available')
  const mailbox = await payload.findByID({ collection: 'mailbox-configurations', id: String(mailboxID), depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
  if ((mailbox.provider !== 'google' && mailbox.provider !== 'microsoft') || mailbox.health !== 'connected') throw new Error('attachment_not_available')
  const refreshed = await refreshAndPersistMailboxOAuth(payload, mailbox, fetcher)
  const data = mailbox.provider === 'google'
    ? await gmailAttachment(fetcher)(refreshed.accessToken, String(record.providerMessageID), String(attachmentID))
    : await microsoftAttachment(fetcher)(refreshed.accessToken, String(record.providerMessageID), String(attachmentID))
  return { data, contentType: contentType(metadata?.contentType), filename: filename(metadata?.name), mailbox: mailboxID, provider: mailbox.provider }
}
