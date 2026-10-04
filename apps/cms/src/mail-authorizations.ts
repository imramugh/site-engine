import { createHash } from 'node:crypto'
import type { Payload } from 'payload'
import { withPayloadTransaction } from './auth-transaction'

export type MailGrant = { recipient: string; sender: string; subject: string; body: string; attachmentHashes: string[]; lead: string; revision: number }
export const normalizeBody = (body: string) => body.replace(/\r\n/g, '\n').trim()
export const authorizationDigest = (draft: MailGrant) => createHash('sha256').update(JSON.stringify({ ...draft, recipient: draft.recipient.trim().toLowerCase(), sender: draft.sender.trim().toLowerCase(), subject: draft.subject.trim(), body: normalizeBody(draft.body), attachmentHashes: [...draft.attachmentHashes].sort() })).digest('hex')
export const authorizationUsable = (grant: { digest: string; expiresAt: string; revokedAt?: string | null; consumedAt?: string | null; draftRevision: number }, draft: MailGrant, now = new Date()) => !grant.revokedAt && !grant.consumedAt && new Date(grant.expiresAt) > now && grant.draftRevision === draft.revision && grant.digest === authorizationDigest(draft)

type Actor = { id: string; roles?: string[] }
type DraftDocument = MailGrant & { id: string; state: string }
const draftGrant = (draft: Record<string, unknown>): DraftDocument => ({ id: String(draft.id), recipient: String(draft.recipient), sender: String(draft.sender), subject: String(draft.subject), body: String(draft.body), attachmentHashes: Array.isArray(draft.attachmentHashes) ? draft.attachmentHashes.map(String) : [], lead: typeof draft.lead === 'string' ? draft.lead : String((draft.lead as { id?: string })?.id), revision: Number(draft.revision), state: String(draft.state) })
const owner = (actor: Actor) => actor.roles?.includes('owner') === true

export async function authorizeMailDraft(payload: Payload, actor: Actor, draftID: string, expiresAt: Date) {
  if (!owner(actor)) throw new Error('owner_authorization_required')
  if (expiresAt <= new Date()) throw new Error('authorization_expired')
  return withPayloadTransaction(payload, async (req) => {
    const draft = draftGrant(await payload.findByID({ collection: 'mail-drafts', id: draftID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>)
    const digest = authorizationDigest(draft)
    const grant = await payload.create({ collection: 'mail-authorizations', data: { draft: draft.id, digest, draftRevision: draft.revision, authorizedBy: actor.id, expiresAt: expiresAt.toISOString() }, overrideAccess: true, req })
    await payload.update({ collection: 'mail-drafts', id: draft.id, data: { state: 'authorized' }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'mail.authorization_granted', user: actor.id, actor: actor.id, detail: { draft: draft.id, grant: grant.id, digest } }, overrideAccess: true, req })
    return grant
  })
}

export async function consumeMailAuthorization(payload: Payload, actor: Actor, grantID: string, now = new Date()) {
  if (!owner(actor)) throw new Error('owner_authorization_required')
  return withPayloadTransaction(payload, async (req) => {
    const grant = await payload.findByID({ collection: 'mail-authorizations', id: grantID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>
    const draftID = typeof grant.draft === 'string' ? grant.draft : String((grant.draft as { id?: string })?.id)
    const draft = draftGrant(await payload.findByID({ collection: 'mail-drafts', id: draftID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>)
    if (!authorizationUsable(grant as never, draft, now)) throw new Error('authorization_not_usable')
    const consumed = await payload.update({ collection: 'mail-authorizations', id: grantID, data: { consumedAt: now.toISOString() }, overrideAccess: true, req })
    await payload.update({ collection: 'mail-drafts', id: draft.id, data: { state: 'consumed' }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'mail.authorization_consumed', user: actor.id, actor: actor.id, detail: { draft: draft.id, grant: grantID } }, overrideAccess: true, req })
    return consumed
  })
}

export async function revokeMailAuthorization(payload: Payload, actor: Actor, grantID: string, now = new Date()) {
  if (!owner(actor)) throw new Error('owner_authorization_required')
  return withPayloadTransaction(payload, async (req) => {
    const grant = await payload.update({ collection: 'mail-authorizations', id: grantID, data: { revokedAt: now.toISOString() }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'mail.authorization_revoked', user: actor.id, actor: actor.id, detail: { grant: grantID } }, overrideAccess: true, req })
    return grant
  })
}
