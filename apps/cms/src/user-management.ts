import type { Payload } from 'payload'
import { withPayloadTransaction } from './auth-transaction'
import { hashOpaqueToken, newOpaqueToken, sessionIsUsable, type IdentityProvider } from './identity'
import { configuredProvider } from './oidc'
import { roles, type Role } from './access'

export class UserManagementError extends Error {
  constructor(message: string, readonly code: 'conflict' | 'invalid' | 'not-found' = 'invalid') { super(message) }
}

const relationID = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' && 'id' in value ? String((value as { id: unknown }).id) : undefined
const roleSet = new Set<string>(roles)
const validRoles = (value: unknown): value is Role[] => Array.isArray(value) && value.length > 0 && value.every((role) => typeof role === 'string' && roleSet.has(role)) && new Set(value).size === value.length
const validEmail = (value: string) => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

export async function loadUsersWorkspace(payload: Payload) {
  const now = new Date().toISOString()
  const [users, sessions, invitations] = await Promise.all([
    payload.find({ collection: 'users', limit: 200, sort: 'name', depth: 0, overrideAccess: true }),
    payload.find({ collection: 'auth-sessions', limit: 500, sort: '-authenticatedAt', depth: 0, overrideAccess: true }),
    payload.find({ collection: 'invitations', where: { and: [{ acceptedAt: { equals: null } }, { expiresAt: { greater_than: now } }] }, limit: 100, sort: '-createdAt', depth: 0, overrideAccess: true }),
  ])
  const lastSignIn = new Map<string, string>()
  for (const session of sessions.docs) {
    const id = relationID(session.user)
    if (id && (!lastSignIn.has(id) || Date.parse(session.authenticatedAt) > Date.parse(lastSignIn.get(id)!))) lastSignIn.set(id, session.authenticatedAt)
  }
  return {
    users: users.docs.map((user) => ({ id: user.id, name: user.name, email: user.email, roles: user.roles, provider: user.provider ?? (user.emergencyTotpSecret ? 'local' : null), disabled: Boolean(user.disabled), lastSignIn: lastSignIn.get(String(user.id)) ?? null })),
    invitations: invitations.docs.map((invite) => ({ id: invite.id, email: invite.email, provider: invite.provider, roles: invite.roles, expiresAt: invite.expiresAt })),
    truncated: users.totalDocs > users.docs.length || invitations.totalDocs > invitations.docs.length,
  }
}

export async function createUserInvitation(payload: Payload, actor: { id: string }, input: { email: string; provider: IdentityProvider; roles: Role[] }) {
  const email = input.email.trim().toLowerCase()
  if (!validEmail(email) || !validRoles(input.roles)) throw new UserManagementError('Enter a valid email and choose at least one role.')
  const provider = configuredProvider(input.provider)
  if (!provider) throw new UserManagementError(`${input.provider === 'microsoft' ? 'Microsoft' : 'Google'} sign-in is not configured.`)
  const origin = process.env.PAYLOAD_PUBLIC_SERVER_URL
  if (!origin) throw new UserManagementError('The public admin URL is not configured.')
  const token = newOpaqueToken()
  const invitation = await withPayloadTransaction(payload, async (req) => {
    const existing = await payload.find({ collection: 'users', where: { email: { equals: email } }, limit: 1, overrideAccess: true, req })
    if (existing.docs[0]) throw new UserManagementError('A user with this email already exists.', 'conflict')
    const prior = await payload.find({ collection: 'invitations', where: { email: { equals: email } }, limit: 10, overrideAccess: true, req })
    if (prior.docs.some((invite) => !invite.acceptedAt && Date.parse(invite.expiresAt) > Date.now())) throw new UserManagementError('An active invitation already exists for this email.', 'conflict')
    for (const invite of prior.docs) await payload.delete({ collection: 'invitations', id: invite.id, overrideAccess: true, req })
    const created = await payload.create({ collection: 'invitations', data: { email, provider: input.provider, providerIssuer: provider.issuer, providerSubject: `unbound:${newOpaqueToken()}`, roles: input.roles, tokenHash: hashOpaqueToken(token), expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'identity.invitation_created', actor: actor.id, detail: { invitationID: created.id, provider: input.provider, roles: input.roles } }, overrideAccess: true, req })
    return created
  })
  return { invitation: { id: invitation.id, email: invitation.email, provider: invitation.provider, roles: invitation.roles, expiresAt: invitation.expiresAt }, inviteURL: new URL(`/api/auth/${input.provider}?invite=${encodeURIComponent(token)}`, origin).href }
}

export async function updateManagedUser(payload: Payload, actor: { id: string }, input: { id: string; name: string; roles: Role[]; disabled: boolean }) {
  const name = input.name.trim()
  if (!input.id || !name || name.length > 160 || !validRoles(input.roles)) throw new UserManagementError('Enter a name and choose at least one role.')
  return withPayloadTransaction(payload, async (req) => {
    const current = await payload.findByID({ collection: 'users', id: input.id, depth: 0, overrideAccess: true, req }).catch(() => undefined)
    if (!current) throw new UserManagementError('User not found.', 'not-found')
    const removesOwner = current.roles?.includes('owner') && (input.disabled || !input.roles.includes('owner'))
    if (removesOwner) {
      const owners = await payload.find({ collection: 'users', where: { roles: { contains: 'owner' } }, limit: 200, depth: 0, overrideAccess: true, req })
      if (owners.docs.filter((user) => !user.disabled).length <= 1) throw new UserManagementError('At least one active Owner is required.', 'conflict')
    }
    req.user = actor as never
    const updated = await payload.update({ collection: 'users', id: input.id, data: { name, roles: input.roles, disabled: input.disabled }, overrideAccess: true, req })
    if (name !== current.name && JSON.stringify(input.roles) === JSON.stringify(current.roles) && input.disabled === Boolean(current.disabled)) await payload.create({ collection: 'audit-events', data: { event: 'identity.profile_updated', user: input.id, actor: actor.id }, overrideAccess: true, req })
    return updated
  })
}

export async function loadAccountSessions(payload: Payload, userID: string, currentToken?: string) {
  const currentHash = currentToken ? hashOpaqueToken(currentToken) : ''
  const rows = await payload.find({ collection: 'auth-sessions', where: { user: { equals: userID } }, sort: '-lastSeenAt', limit: 50, depth: 0, overrideAccess: true })
  return rows.docs.map((session) => ({ id: session.id, authenticatedAt: session.authenticatedAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt, current: session.tokenHash === currentHash, active: sessionIsUsable(session) }))
}

export async function revokeAccountSessions(payload: Payload, actor: { id: string }, input: { sessionID?: string; all?: boolean }) {
  return withPayloadTransaction(payload, async (req) => {
    const now = new Date().toISOString()
    if (input.all) {
      await payload.update({ collection: 'auth-sessions', where: { user: { equals: actor.id } }, data: { revokedAt: now }, overrideAccess: true, req })
      await payload.create({ collection: 'audit-events', data: { event: 'identity.sessions_revoked', user: actor.id, actor: actor.id, detail: { scope: 'all' } }, overrideAccess: true, req })
      return { all: true }
    }
    if (!input.sessionID) throw new UserManagementError('Choose a session to revoke.')
    const session = await payload.findByID({ collection: 'auth-sessions', id: input.sessionID, depth: 0, overrideAccess: true, req }).catch(() => undefined)
    if (!session || relationID(session.user) !== actor.id) throw new UserManagementError('Session not found.', 'not-found')
    await payload.update({ collection: 'auth-sessions', id: session.id, data: { revokedAt: now }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'identity.session_revoked', user: actor.id, actor: actor.id, detail: { sessionID: session.id } }, overrideAccess: true, req })
    return { all: false, sessionID: session.id }
  })
}
