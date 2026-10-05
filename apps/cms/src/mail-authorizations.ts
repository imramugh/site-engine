import { createHash } from 'node:crypto'
import type { Payload, PayloadRequest } from 'payload'
import { withPayloadTransaction } from './auth-transaction'
import { hasFreshAuthentication, hashOpaqueToken, sessionIsUsable } from './identity'
import { assertLeadAcceptsOutbound } from './lead-outbound'

export type MailGrant = { recipient: string; sender: string; subject: string; body: string; attachmentHashes: string[]; lead: string; revision: number }
export const normalizeBody = (body: string) => body.replace(/\r\n/g, '\n').trim()
export const authorizationDigest = (draft: MailGrant) => createHash('sha256').update(JSON.stringify({
  recipient: draft.recipient.trim().toLowerCase(), sender: draft.sender.trim().toLowerCase(), subject: draft.subject.trim(), body: normalizeBody(draft.body), attachmentHashes: [...draft.attachmentHashes].sort(), lead: draft.lead, revision: draft.revision,
})).digest('hex')
export const authorizationUsable = (grant: { digest: string; expiresAt: string; revokedAt?: string | null; consumedAt?: string | null; draftRevision: number }, draft: MailGrant, now = new Date()) => !grant.revokedAt && !grant.consumedAt && new Date(grant.expiresAt) > now && grant.draftRevision === draft.revision && grant.digest === authorizationDigest(draft)

type Actor = { id: string; sessionToken?: string }
type DraftDocument = MailGrant & { id: string; state: string; application?: string }
const relationID = (value: unknown) => typeof value === 'string' ? value : String((value as { id?: string } | null)?.id ?? '')
const draftGrant = (draft: Record<string, unknown>): DraftDocument => {
  const lead = relationID(draft.lead); const application = relationID(draft.application)
  return { id: String(draft.id), recipient: String(draft.recipient), sender: String(draft.sender), subject: String(draft.subject), body: String(draft.body), attachmentHashes: Array.isArray(draft.attachmentHashes) ? draft.attachmentHashes.map(String) : [], lead: lead || application, application: application || undefined, revision: Number(draft.revision), state: String(draft.state) }
}
const consumptionLocks = new Map<string, Promise<void>>()

async function freshOwner(payload: Payload, actor: Actor, req: PayloadRequest): Promise<boolean> {
  if (!actor.sessionToken) return false
  const sessions = await payload.find({ collection: 'auth-sessions', where: { tokenHash: { equals: hashOpaqueToken(actor.sessionToken) } }, limit: 1, depth: 0, overrideAccess: true, req })
  const session = sessions.docs[0]
  const sessionUserID = typeof session?.user === 'string' ? session.user : session?.user?.id
  if (!session || sessionUserID !== actor.id || !sessionIsUsable(session) || !hasFreshAuthentication(session)) return false
  try {
    const user = await payload.findByID({ collection: 'users', id: actor.id, depth: 0, overrideAccess: true, req })
    return !user.disabled && user.roles?.includes('owner') === true
  } catch {
    return false
  }
}

async function exclusivelyConsume<T>(grantID: string, operation: () => Promise<T>): Promise<T> {
  const previous = consumptionLocks.get(grantID) ?? Promise.resolve()
  let release: () => void = () => undefined
  const current = new Promise<void>((resolve) => { release = resolve })
  consumptionLocks.set(grantID, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (consumptionLocks.get(grantID) === current) consumptionLocks.delete(grantID)
  }
}

export async function authorizeMailDraft(payload: Payload, actor: Actor, draftID: string, expiresAt: Date) {
  if (expiresAt <= new Date()) throw new Error('authorization_expired')
  return withPayloadTransaction(payload, async (req) => {
    if (!await freshOwner(payload, actor, req)) throw new Error('owner_authorization_required')
    const draft = draftGrant(await payload.findByID({ collection: 'mail-drafts', id: draftID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>)
    if (!draft.application) await assertLeadAcceptsOutbound(payload, draft.lead, req)
    const digest = authorizationDigest(draft)
    const active = await payload.find({ collection: 'mail-authorizations', where: { and: [{ draft: { equals: draft.id } }, { revokedAt: { exists: false } }, { consumedAt: { exists: false } }] }, depth: 0, overrideAccess: true, req })
    await Promise.all(active.docs.map((existing) => payload.update({ collection: 'mail-authorizations', id: existing.id, data: { revokedAt: new Date().toISOString() }, overrideAccess: true, req })))
    const grant = await payload.create({ collection: 'mail-authorizations', data: { draft: draft.id, digest, draftRevision: draft.revision, authorizedBy: actor.id, expiresAt: expiresAt.toISOString() }, overrideAccess: true, req })
    await payload.update({ collection: 'mail-drafts', id: draft.id, data: { state: 'authorized' }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'mail.authorization_granted', user: actor.id, actor: actor.id, detail: { draft: draft.id, grant: grant.id, digest } }, overrideAccess: true, req })
    return grant
  })
}

export async function consumeMailAuthorization(payload: Payload, actor: Actor, grantID: string, now = new Date()) {
  return exclusivelyConsume(grantID, () => withPayloadTransaction(payload, async (req) => {
    if (!await freshOwner(payload, actor, req)) throw new Error('owner_authorization_required')
    const grant = await payload.findByID({ collection: 'mail-authorizations', id: grantID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>
    const draftID = typeof grant.draft === 'string' ? grant.draft : String((grant.draft as { id?: string })?.id)
    const draft = draftGrant(await payload.findByID({ collection: 'mail-drafts', id: draftID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>)
    if (!draft.application) await assertLeadAcceptsOutbound(payload, draft.lead, req)
    if (draft.state !== 'authorized' || !authorizationUsable(grant as never, draft, now)) throw new Error('authorization_not_usable')
    const consumed = await payload.update({ collection: 'mail-authorizations', id: grantID, data: { consumedAt: now.toISOString() }, overrideAccess: true, req })
    await payload.update({ collection: 'mail-drafts', id: draft.id, data: { state: 'consumed' }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'mail.authorization_consumed', user: actor.id, actor: actor.id, detail: { draft: draft.id, grant: grantID } }, overrideAccess: true, req })
    return consumed
  }))
}

export async function revokeMailAuthorization(payload: Payload, actor: Actor, grantID: string, now = new Date()) {
  return withPayloadTransaction(payload, async (req) => {
    if (!await freshOwner(payload, actor, req)) throw new Error('owner_authorization_required')
    const grant = await payload.update({ collection: 'mail-authorizations', id: grantID, data: { revokedAt: now.toISOString() }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'mail.authorization_revoked', user: actor.id, actor: actor.id, detail: { grant: grantID } }, overrideAccess: true, req })
    return grant
  })
}
