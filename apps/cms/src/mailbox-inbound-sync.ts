import type { Payload } from 'payload'
import { appendMatchedInbound } from './mail-inbound'
import { gmailAdapter, gmailIdentity, microsoftAdapter, type Fetcher } from './mail-provider-adapters'
import { refreshAndPersistMailboxOAuth } from './mailbox-oauth'

type Mailbox = { id: string; provider: 'microsoft' | 'google' | 'smtp'; health: string; credentialRevision: string; inboundCursor?: string | null; inboundCursorRevision?: string | null }
type GoogleCursor = { historyID: string; pageToken?: string }
type SyncResult = { skipped: true; processed: number } | { skipped: false; processed: number }

const internal = { mailboxInternal: true }
const activeSyncs = new Map<string, Promise<unknown>>()
const opaque = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value)

function googleCursor(value: unknown): GoogleCursor | undefined {
  if (typeof value !== 'string' || value.length > 1000) return undefined
  try {
    const parsed = JSON.parse(value) as GoogleCursor
    return /^[0-9]{1,40}$/.test(parsed.historyID) && (!parsed.pageToken || opaque(parsed.pageToken)) ? parsed : undefined
  } catch { return undefined }
}

async function currentMailbox(payload: Payload, id: string): Promise<Mailbox> {
  return await payload.findByID({ collection: 'mailbox-configurations', id, depth: 0, overrideAccess: true }) as unknown as Mailbox
}

async function unchanged(payload: Payload, mailbox: Mailbox) {
  const current = await currentMailbox(payload, mailbox.id)
  if (current.provider !== mailbox.provider || current.health !== 'connected' || current.credentialRevision !== mailbox.credentialRevision) throw new Error('mailbox_configuration_changed')
}

async function carryCursorAcrossCredentialRotation(payload: Payload, before: Mailbox, refreshedRevision: string) {
  if (before.inboundCursorRevision !== before.credentialRevision) return
  const saved = await (payload as any).update({
    collection: 'mailbox-configurations',
    where: {
      and: [
        { id: { equals: before.id } },
        { credentialRevision: { equals: refreshedRevision } },
        { inboundCursor: { equals: before.inboundCursor ?? null } },
        { inboundCursorRevision: { equals: before.inboundCursorRevision } },
      ],
    },
    data: { inboundCursorRevision: refreshedRevision },
    overrideAccess: true,
    context: internal,
  })
  if (saved.docs.length !== 1) throw new Error('mailbox_configuration_changed')
}

/** Polls one configured delegated mailbox. Cursors advance only after the full
 * bounded page has been appended, so a restart safely replays idempotent IDs. */
export function syncMailboxInbound(payload: Payload, mailboxID: string, fetcher: Fetcher = fetch): Promise<SyncResult> {
  const active = activeSyncs.get(mailboxID)
  if (active) return active.then(() => syncMailboxInbound(payload, mailboxID, fetcher))
  const operation = syncMailboxInboundInner(payload, mailboxID, fetcher).finally(() => {
    if (activeSyncs.get(mailboxID) === operation) activeSyncs.delete(mailboxID)
  })
  activeSyncs.set(mailboxID, operation)
  return operation
}

async function syncMailboxInboundInner(payload: Payload, mailboxID: string, fetcher: Fetcher = fetch): Promise<SyncResult> {
  const mailbox = await currentMailbox(payload, mailboxID)
  if ((mailbox.provider !== 'microsoft' && mailbox.provider !== 'google') || mailbox.health !== 'connected') return { skipped: true as const, processed: 0 }
  const refreshed = await refreshAndPersistMailboxOAuth(payload, mailbox, fetcher)
  if (refreshed.credentialRevision !== mailbox.credentialRevision) await carryCursorAcrossCredentialRotation(payload, mailbox, refreshed.credentialRevision)
  const active = await currentMailbox(payload, mailboxID)
  if (active.provider !== mailbox.provider || active.health !== 'connected' || active.credentialRevision !== refreshed.credentialRevision) throw new Error('mailbox_configuration_changed')
  const cursor = active.inboundCursorRevision === active.credentialRevision ? active.inboundCursor : undefined
  let nextCursor: string | null = null
  let processed = 0

  if (active.provider === 'microsoft') {
    const page = await microsoftAdapter(fetcher, 'sync@example.invalid').poll(refreshed.accessToken, 'inbox', cursor ?? undefined)
    for (const message of page.messages) {
      await unchanged(payload, active)
      await appendMatchedInbound(payload, { mailbox: active.id, provider: 'microsoft', conversationID: message.threadId, messageID: message.messageId, sender: message.sender, recipient: message.recipient, subject: message.subject, body: message.body, receivedAt: message.date, attachmentMetadata: message.attachments })
      processed += 1
    }
    nextCursor = page.cursor
  } else {
    let position = googleCursor(cursor)
    if (!position) {
      const identity = await gmailIdentity(fetcher)(refreshed.accessToken)
      if (!identity.historyID) throw new Error('provider_malformed_response')
      nextCursor = JSON.stringify({ historyID: identity.historyID })
    } else {
      const adapter = gmailAdapter(fetcher, 'sync@example.invalid')
      const page = await adapter.poll(refreshed.accessToken, position.historyID, position.pageToken)
      const ids = page.entries.flatMap((entry) => Array.isArray((entry as { messagesAdded?: unknown }).messagesAdded) ? (entry as { messagesAdded: Array<{ message?: { id?: unknown } }> }).messagesAdded.map((item) => item.message?.id).filter((id): id is string => opaque(id)) : [])
      const uniqueIDs = [...new Set(ids)]
      if (uniqueIDs.length > 500) throw new Error('provider_page_too_large')
      for (const id of uniqueIDs) {
        const message = await adapter.message(refreshed.accessToken, id)
        await unchanged(payload, active)
        await appendMatchedInbound(payload, { mailbox: active.id, provider: 'google', conversationID: message.threadId, messageID: message.messageId, sender: message.sender, recipient: message.recipient, subject: message.subject, body: message.body, receivedAt: message.date, attachmentMetadata: message.attachments })
        processed += 1
      }
      nextCursor = JSON.stringify(page.nextPageToken ? { historyID: position.historyID, pageToken: page.nextPageToken } : { historyID: page.historyID })
    }
  }
  const saved = await (payload as any).update({ collection: 'mailbox-configurations', where: { and: [{ id: { equals: active.id } }, { credentialRevision: { equals: active.credentialRevision } }, { health: { equals: 'connected' } }, { inboundCursor: { equals: active.inboundCursor ?? null } }, { inboundCursorRevision: { equals: active.inboundCursorRevision ?? null } }] }, data: { inboundCursor: nextCursor, inboundCursorRevision: active.credentialRevision }, overrideAccess: true, context: internal })
  if (saved.docs.length !== 1) throw new Error('mailbox_configuration_changed')
  return { skipped: false as const, processed }
}
