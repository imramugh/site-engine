import { createHash } from 'node:crypto'
import type { Payload, PayloadRequest } from 'payload'
import { withPayloadTransaction } from './auth-transaction'
import { hasFreshAuthentication, hashOpaqueToken, sessionIsUsable } from './identity'
import { assertLeadAcceptsOutbound } from './lead-outbound'

export type MailGrant = { recipient: string; sender: string; subject: string; body: string; attachmentHashes: string[]; attachments?: unknown[]; lead: string; application?: string; threadID?: string; revision: number }
export const normalizeBody = (body: string) => body.replace(/\r\n/g, '\n').trim()
export const authorizationDigest = (draft: MailGrant) => {
  const assistant = draft as DraftDocument
  const source = assistant.assistantClientIDHash && assistant.assistantActor && assistant.assistantOAuthSessionID
    ? { assistantClientIDHash: assistant.assistantClientIDHash, assistantActor: assistant.assistantActor, assistantOAuthSessionID: assistant.assistantOAuthSessionID }
    : {}
  const attachments = Array.isArray(draft.attachments) && draft.attachments.length ? { attachments: draft.attachments.map((attachment) => JSON.stringify(attachment)).sort() } : {}
  return createHash('sha256').update(JSON.stringify({ recipient: draft.recipient.trim().toLowerCase(), sender: draft.sender.trim().toLowerCase(), subject: draft.subject.trim(), body: normalizeBody(draft.body), attachmentHashes: [...draft.attachmentHashes].sort(), lead: draft.lead, targetKind: draft.application ? 'application' : 'lead', threadID: draft.threadID ?? '', revision: draft.revision, ...attachments, ...source })).digest('hex')
}
export const authorizationUsable = (grant: { digest: string; expiresAt: string; revokedAt?: string | null; consumedAt?: string | null; draftRevision: number }, draft: MailGrant, now = new Date()) => !grant.revokedAt && !grant.consumedAt && new Date(grant.expiresAt) > now && grant.draftRevision === draft.revision && grant.digest === authorizationDigest(draft)

type Actor = { id: string; sessionToken?: string }
type DraftDocument = MailGrant & { id: string; state: string; application?: string; threadID: string; assistantClientIDHash?: string; assistantActor?: string; assistantOAuthSessionID?: string }
const relationID = (value: unknown) => typeof value === 'string' ? value : String((value as { id?: string } | null)?.id ?? '')
const grantActorID = (grant: Record<string, unknown>) => relationID(grant.authorizedBy)
const draftGrant = (draft: Record<string, unknown>): DraftDocument => {
  const lead = relationID(draft.lead); const application = relationID(draft.application)
  return { id: String(draft.id), threadID: String(draft.threadID), recipient: String(draft.recipient), sender: String(draft.sender), subject: String(draft.subject), body: String(draft.body), attachmentHashes: Array.isArray(draft.attachmentHashes) ? draft.attachmentHashes.map(String) : [], ...(Array.isArray(draft.attachments) ? { attachments: draft.attachments } : {}), lead: lead || application, application: application || undefined, revision: Number(draft.revision), state: String(draft.state), ...(typeof draft.assistantClientIDHash === 'string' ? { assistantClientIDHash: draft.assistantClientIDHash } : {}), ...(relationID(draft.assistantActor) ? { assistantActor: relationID(draft.assistantActor) } : {}), ...(typeof draft.assistantOAuthSessionID === 'string' ? { assistantOAuthSessionID: draft.assistantOAuthSessionID } : {}) }
}
const consumptionLocks = new Map<string, Promise<void>>()

async function freshAuthorizedSession(payload: Payload, actor: Actor, draft: DraftDocument, req: PayloadRequest): Promise<string | undefined> {
  if (!actor.sessionToken) return undefined
  const sessions = await payload.find({ collection: 'auth-sessions', where: { tokenHash: { equals: hashOpaqueToken(actor.sessionToken) } }, limit: 1, depth: 0, overrideAccess: true, req })
  const session = sessions.docs[0]
  const sessionUserID = typeof session?.user === 'string' ? session.user : session?.user?.id
  if (!session || sessionUserID !== actor.id || !sessionIsUsable(session) || !hasFreshAuthentication(session)) return undefined
  try {
    const user = await payload.findByID({ collection: 'users', id: actor.id, depth: 0, overrideAccess: true, req })
    if (user.disabled) return undefined
    const roles = user.roles ?? []
    return roles.includes('owner') || (!draft.application && roles.includes('sales')) || (Boolean(draft.application) && roles.includes('hiring')) ? String(session.id) : undefined
  } catch (error) { if (error instanceof Error && /not found/i.test(error.message)) return undefined; throw error }
}
async function freshAuthorizedActor(payload: Payload, actor: Actor, draft: DraftDocument, req: PayloadRequest): Promise<boolean> { return Boolean(await freshAuthorizedSession(payload, actor, draft, req)) }

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
    const draft = draftGrant(await payload.findByID({ collection: 'mail-drafts', id: draftID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>)
    const confirmationSessionID = await freshAuthorizedSession(payload, actor, draft, req)
    if (!confirmationSessionID) throw new Error('mail_authorization_required')
    if (draft.assistantActor && draft.assistantActor !== actor.id) throw new Error('mail_authorization_required')
    if (!draft.application) await assertLeadAcceptsOutbound(payload, draft.lead, req)
    else await payload.findByID({ collection: 'applications', id: draft.application, depth: 0, overrideAccess: true, req })
    if (draft.state !== 'prepared') throw new Error('draft_not_prepared')
    const digest = authorizationDigest(draft)
    const active = await payload.find({ collection: 'mail-authorizations', where: { and: [{ draft: { equals: draft.id } }, { revokedAt: { exists: false } }, { consumedAt: { exists: false } }] }, depth: 0, overrideAccess: true, req })
    await Promise.all(active.docs.map((existing) => payload.update({ collection: 'mail-authorizations', id: existing.id, data: { revokedAt: new Date().toISOString() }, overrideAccess: true, req })))
    const grant = await payload.create({ collection: 'mail-authorizations', data: { draft: draft.id, digest, draftRevision: draft.revision, authorizedBy: actor.id, humanConfirmationSessionID: confirmationSessionID, expiresAt: expiresAt.toISOString(), ...(draft.assistantClientIDHash && draft.assistantActor && draft.assistantOAuthSessionID ? { assistantClientIDHash: draft.assistantClientIDHash, assistantActor: draft.assistantActor, assistantOAuthSessionID: draft.assistantOAuthSessionID } : {}) } as never, overrideAccess: true, req })
    await payload.update({ collection: 'mail-drafts', id: draft.id, data: { state: 'authorized' }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'mail.authorization_granted', user: actor.id, actor: actor.id, detail: { draft: draft.id, grant: grant.id, digest } }, overrideAccess: true, req })
    return grant
  })
}

export async function consumeMailAuthorization(payload: Payload, actor: Actor, grantID: string, now = new Date()) {
  return exclusivelyConsume(grantID, async () => {
    const outcome = await withPayloadTransaction(payload, async (req) => {
      const grant = await payload.findByID({ collection: 'mail-authorizations', id: grantID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>
      const draftID = relationID(grant.draft)
      const draft = draftGrant(await payload.findByID({ collection: 'mail-drafts', id: draftID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>)
      if (!await freshAuthorizedActor(payload, actor, draft, req) || grantActorID(grant) !== actor.id) throw new Error('mail_authorization_required')
      if (!draft.application) await assertLeadAcceptsOutbound(payload, draft.lead, req)
      else await payload.findByID({ collection: 'applications', id: draft.application, depth: 0, overrideAccess: true, req })
      const exactCurrentGrant = !grant.revokedAt && !grant.consumedAt && grant.draftRevision === draft.revision && grant.digest === authorizationDigest(draft)
      if (draft.state !== 'authorized' || !authorizationUsable(grant as never, draft, now)) {
        if (draft.state === 'authorized' && exactCurrentGrant && new Date(String(grant.expiresAt)) <= now) {
          await payload.update({ collection: 'mail-drafts', id: draft.id, data: { state: 'expired' }, overrideAccess: true, req })
          await payload.create({ collection: 'audit-events', data: { event: 'mail.authorization_expired', user: actor.id, actor: actor.id, detail: { draft: draft.id, grant: grantID } }, overrideAccess: true, req })
          return { expired: true }
        }
        throw new Error('authorization_not_usable')
      }
      const consumed = await payload.update({ collection: 'mail-authorizations', id: grantID, data: { consumedAt: now.toISOString() }, overrideAccess: true, req })
      await payload.update({ collection: 'mail-drafts', id: draft.id, data: { state: 'consumed' }, overrideAccess: true, req })
      await payload.create({ collection: 'audit-events', data: { event: 'mail.authorization_consumed', user: actor.id, actor: actor.id, detail: { draft: draft.id, grant: grantID } }, overrideAccess: true, req })
      return { consumed, draft }
    })
    if (outcome.expired) throw new Error('authorization_not_usable')
    return { ...outcome.consumed!, envelope: Object.freeze({ ...outcome.draft!, attachmentHashes: [...outcome.draft!.attachmentHashes] }) }
  })
}

export type McpMailIdentity = { userID: string; clientIDHash: string; oauthSessionID: string }
/** Consume an MCP grant only after re-checking the assistant's current OAuth
 * identity and the independently fresh browser session that confirmed it. */
export async function consumeMcpMailAuthorization(payload: Payload, identity: McpMailIdentity, grantID: string, now = new Date()) {
  return exclusivelyConsume(grantID, async () => {
    const outcome = await withPayloadTransaction(payload, async (req) => {
      const grant = await payload.findByID({ collection: 'mail-authorizations', id: grantID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>
      const draftID = relationID(grant.draft)
      const draft = draftGrant(await payload.findByID({ collection: 'mail-drafts', id: draftID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>)
      const confirmationSessionID = typeof grant.humanConfirmationSessionID === 'string' ? grant.humanConfirmationSessionID : ''
      const boundActor = relationID(grant.assistantActor)
      if (!confirmationSessionID || !draft.assistantClientIDHash || !draft.assistantActor || !draft.assistantOAuthSessionID || grant.assistantClientIDHash !== identity.clientIDHash || boundActor !== identity.userID || grant.assistantOAuthSessionID !== identity.oauthSessionID || draft.assistantClientIDHash !== identity.clientIDHash || draft.assistantActor !== identity.userID || draft.assistantOAuthSessionID !== identity.oauthSessionID || grantActorID(grant) !== identity.userID) throw new Error('mail_authorization_required')
      const session = await payload.findByID({ collection: 'auth-sessions', id: confirmationSessionID, depth: 0, overrideAccess: true, req })
      const sessionUserID = relationID(session.user)
      if (sessionUserID !== identity.userID || !sessionIsUsable(session) || !hasFreshAuthentication(session)) throw new Error('mail_authorization_required')
      const user = await payload.findByID({ collection: 'users', id: identity.userID, depth: 0, overrideAccess: true, req })
      const roles = user.roles ?? []
      if (user.disabled || !(roles.includes('owner') || (!draft.application && roles.includes('sales')) || (Boolean(draft.application) && roles.includes('hiring')))) throw new Error('mail_authorization_required')
      if (!draft.application) await assertLeadAcceptsOutbound(payload, draft.lead, req)
      else await payload.findByID({ collection: 'applications', id: draft.application, depth: 0, overrideAccess: true, req })
      const exactCurrentGrant = !grant.revokedAt && !grant.consumedAt && grant.draftRevision === draft.revision && grant.digest === authorizationDigest(draft)
      if (draft.state !== 'authorized' || !authorizationUsable(grant as never, draft, now)) {
        if (draft.state === 'authorized' && exactCurrentGrant && new Date(String(grant.expiresAt)) <= now) {
          await payload.update({ collection: 'mail-drafts', id: draft.id, data: { state: 'expired' }, overrideAccess: true, req })
          await payload.create({ collection: 'audit-events', data: { event: 'mail.authorization_expired', user: identity.userID, actor: identity.userID, detail: { draft: draft.id, grant: grantID, clientIdHash: identity.clientIDHash } }, overrideAccess: true, req })
          return { expired: true }
        }
        throw new Error('authorization_not_usable')
      }
      const consumed = await payload.update({ collection: 'mail-authorizations', id: grantID, data: { consumedAt: now.toISOString() }, overrideAccess: true, req })
      await payload.update({ collection: 'mail-drafts', id: draft.id, data: { state: 'consumed' }, overrideAccess: true, req })
      await payload.create({ collection: 'audit-events', data: { event: 'mcp.mail_authorization_consumed', user: identity.userID, actor: identity.userID, detail: { draft: draft.id, grant: grantID, clientIdHash: identity.clientIDHash, originOAuthSessionID: identity.oauthSessionID, humanConfirmationSessionID: confirmationSessionID } }, overrideAccess: true, req })
      return { consumed, draft }
    })
    if (outcome.expired) throw new Error('authorization_not_usable')
    return { ...outcome.consumed!, envelope: Object.freeze({ ...outcome.draft!, attachmentHashes: [...outcome.draft!.attachmentHashes] }) }
  })
}

export async function revokeMailAuthorization(payload: Payload, actor: Actor, grantID: string, now = new Date()) {
  return withPayloadTransaction(payload, async (req) => {
    const grant = await payload.findByID({ collection: 'mail-authorizations', id: grantID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>
    const draftID = relationID(grant.draft)
    const draft = draftGrant(await payload.findByID({ collection: 'mail-drafts', id: draftID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>)
    if (!await freshAuthorizedActor(payload, actor, draft, req) || grantActorID(grant) !== actor.id) throw new Error('mail_authorization_required')
    const exactCurrentGrant = !grant.revokedAt && !grant.consumedAt && grant.draftRevision === draft.revision && grant.digest === authorizationDigest(draft)
    if (draft.state !== 'authorized' || !exactCurrentGrant) throw new Error('authorization_not_usable')
    const revoked = await payload.update({ collection: 'mail-authorizations', id: grantID, data: { revokedAt: now.toISOString() }, overrideAccess: true, req })
    await payload.update({ collection: 'mail-drafts', id: draft.id, data: { state: 'canceled' }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'mail.authorization_cancelled', user: actor.id, actor: actor.id, detail: { draft: draft.id, grant: grantID } }, overrideAccess: true, req })
    return revoked
  })
}

/** Discard an unconfirmed envelope without creating a send grant. */
export async function cancelPreparedMailDraft(payload: Payload, actor: Actor, draftID: string) {
  return withPayloadTransaction(payload, async (req) => {
    const draft = draftGrant(await payload.findByID({ collection: 'mail-drafts', id: draftID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>)
    if (!await freshAuthorizedActor(payload, actor, draft, req)) throw new Error('mail_authorization_required')
    if (draft.state !== 'prepared') throw new Error('authorization_not_usable')
    await payload.update({ collection: 'mail-drafts', id: draft.id, data: { state: 'canceled' }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'mail.draft_cancelled', user: actor.id, actor: actor.id, detail: { draft: draft.id } }, overrideAccess: true, req })
  })
}
