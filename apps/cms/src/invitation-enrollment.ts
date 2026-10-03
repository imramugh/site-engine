import type { Payload } from 'payload'
import { withPayloadTransaction } from './auth-transaction'
import { hashOpaqueToken, newOpaqueToken, type IdentityProvider } from './identity'

export class InitialEnrollmentError extends Error {}

export async function createInitialOwnerInvitation(payload: Payload, input: { email: string; provider: IdentityProvider; providerIssuer: string; providerSubject?: string }) {
  const invite = newOpaqueToken()
  await withPayloadTransaction(payload, async (req) => {
    const users = await payload.count({ collection: 'users', overrideAccess: true, req })
    await payload.delete({ collection: 'invitations', where: { expiresAt: { less_than: new Date().toISOString() } }, overrideAccess: true, req })
    const invitations = await payload.count({ collection: 'invitations', overrideAccess: true, req })
    if (users.totalDocs > 0 || invitations.totalDocs > 0) throw new InitialEnrollmentError('Initial enrollment is already complete or in progress.')
    const invitation = await payload.create({ collection: 'invitations', data: { email: input.email, provider: input.provider, providerIssuer: input.providerIssuer, providerSubject: input.providerSubject || `unbound:${newOpaqueToken()}`, requiredSubject: input.providerSubject, roles: ['owner'], tokenHash: hashOpaqueToken(invite), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString() }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'identity.initial_invitation_created', detail: { source: 'operator-cli', invitationID: invitation.id, provider: input.provider } }, overrideAccess: true, req })
  })
  return invite
}
