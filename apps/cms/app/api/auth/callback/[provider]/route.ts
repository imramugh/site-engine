import { NextResponse } from 'next/server'
import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { cookieName, hashOpaqueToken, newOpaqueToken, readCookie, SESSION_ABSOLUTE_SECONDS, SESSION_COOKIE, SESSION_IDLE_SECONDS, OIDC_TRANSACTION_COOKIE, type IdentityProvider } from '../../../../../src/identity'
import { withPayloadTransaction } from '../../../../../src/auth-transaction'
import { configuredProvider, validateCallback } from '../../../../../src/oidc'
import { auditCallbackDenial, auditIdentityDecision } from '../../../../../src/identity-audit'

const validProvider = (value: string): value is IdentityProvider => value === 'google' || value === 'microsoft'

class CallbackFailure extends Error {
  constructor(readonly status: number, message: string, readonly reason: 'transaction_not_current' | 'transaction_provider_mismatch' | 'identity_verification_failed' | 'invitation_not_authorized' | 'identity_already_bound' | 'identity_disabled', readonly userID?: string) {
    super(message)
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params
  const state = new URL(request.url).searchParams.get('state')
  if (!state || !validProvider(provider)) return new NextResponse('Invalid sign-in response.', { status: 400 })
  const settings = configuredProvider(provider)
  if (!settings) return new NextResponse('This identity provider has not been configured.', { status: 503 })
  const payload = await getPayload({ config })
  if (readCookie(request.headers, cookieName(OIDC_TRANSACTION_COOKIE)) !== hashOpaqueToken(state)) return new NextResponse('Sign-in browser binding is invalid.', { status: 400 })
  const stateHash = hashOpaqueToken(state)
  const transactions = await payload.find({ collection: 'auth-transactions', where: { stateHash: { equals: stateHash } }, limit: 1, overrideAccess: true })
  const transaction = transactions.docs[0]
  if (!transaction || transaction.consumedAt || new Date(transaction.expiresAt).getTime() <= Date.now()) return new NextResponse('Sign-in request expired or was already used.', { status: 400 })
  if (transaction.provider !== provider) {
    await auditCallbackDenial(payload, { transactionID: String(transaction.id), provider, reason: 'transaction_provider_mismatch' })
    return new NextResponse('Sign-in request expired or was already used.', { status: 400 })
  }

  // The code exchange can contact a remote issuer. Do it before opening SQLite's
  // write transaction, then re-read and compare-and-set the state inside it.
  let identity: Awaited<ReturnType<typeof validateCallback>>
  try {
    identity = await validateCallback(provider, settings, request, state, transaction.nonce, transaction.verifier)
  } catch {
    await auditCallbackDenial(payload, { transactionID: String(transaction.id), provider, reason: 'identity_verification_failed' })
    return new NextResponse('Identity verification failed.', { status: 401 })
  }

  try {
    const token = newOpaqueToken()
    const now = new Date()
    await withPayloadTransaction(payload, async (req) => {
      const current = await payload.find({ collection: 'auth-transactions', where: { stateHash: { equals: stateHash } }, limit: 1, overrideAccess: true, req })
      const currentTransaction = current.docs[0]
      if (!currentTransaction || currentTransaction.provider !== provider || currentTransaction.consumedAt || new Date(currentTransaction.expiresAt).getTime() <= Date.now()) throw new CallbackFailure(400, 'Sign-in request expired or was already used.', 'transaction_not_current')

      const consumed = await payload.update({
        collection: 'auth-transactions',
        where: { and: [{ id: { equals: currentTransaction.id } }, { consumedAt: { equals: null } }] },
        data: { consumedAt: now.toISOString() },
        overrideAccess: true,
        req,
      })
      if (consumed.docs.length !== 1) throw new CallbackFailure(400, 'Sign-in request expired or was already used.', 'transaction_not_current')

      const existing = await payload.find({ collection: 'users', where: { and: [{ provider: { equals: provider } }, { providerIssuer: { equals: settings.issuer } }, { providerSubject: { equals: identity.subject } }] }, limit: 1, overrideAccess: true, req })
      const invitationID = typeof currentTransaction.invitation === 'string' ? currentTransaction.invitation : currentTransaction.invitation?.id
      const invitation = invitationID ? await payload.findByID({ collection: 'invitations', id: invitationID, overrideAccess: true, req }) : undefined
      const normalizedEmail = identity.email.trim().toLowerCase()
      const legacySubject = invitation?.providerSubject?.startsWith('unbound:') ? undefined : invitation?.providerSubject
      const requiredSubject = invitation?.requiredSubject ?? legacySubject
      const invitationMatchesIdentity = invitation && invitation.provider === provider && invitation.providerIssuer === settings.issuer && (!requiredSubject || requiredSubject === identity.subject) && invitation.email.trim().toLowerCase() === normalizedEmail && !invitation.acceptedAt && new Date(invitation.expiresAt).getTime() > now.getTime()
      if ((!existing.docs[0] && !invitationMatchesIdentity) || (invitation && !invitationMatchesIdentity)) throw new CallbackFailure(403, 'This verified identity has not been invited.', 'invitation_not_authorized')
      const sameEmail = await payload.find({ collection: 'users', where: { email: { equals: normalizedEmail } }, limit: 1, overrideAccess: true, req })
      if (!existing.docs[0] && sameEmail.docs[0]) throw new CallbackFailure(403, 'This email is already bound to a different identity.', 'identity_already_bound', String(sameEmail.docs[0].id))
      const user = existing.docs[0] || await payload.create({ collection: 'users', data: { email: normalizedEmail, name: identity.name || normalizedEmail, roles: invitation!.roles, invitedAt: now.toISOString(), provider, providerIssuer: settings.issuer, providerSubject: identity.subject }, overrideAccess: true, req })
      if (user.disabled) throw new CallbackFailure(403, 'This identity is disabled.', 'identity_disabled', String(user.id))
      if (invitation) {
        const redeemed = await payload.update({ collection: 'invitations', where: { and: [{ id: { equals: invitation.id } }, { acceptedAt: { equals: null } }] }, data: { acceptedAt: now.toISOString() }, overrideAccess: true, req })
        if (redeemed.docs.length !== 1) throw new CallbackFailure(403, 'This verified identity has not been invited.', 'invitation_not_authorized')
      }
      await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: now.toISOString(), lastSeenAt: now.toISOString(), expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_SECONDS * 1000).toISOString() }, overrideAccess: true, req })
      await auditIdentityDecision({ payload, req, event: 'identity.signed_in', user: user.id, provider })
    })
    const response = NextResponse.redirect(new URL('/admin', settings.redirectURI))
    response.cookies.set(cookieName(SESSION_COOKIE), token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: SESSION_ABSOLUTE_SECONDS })
    response.cookies.delete(cookieName(OIDC_TRANSACTION_COOKIE))
    return response
  } catch (error) {
    if (error instanceof CallbackFailure) {
      await auditCallbackDenial(payload, { transactionID: String(transaction.id), provider, reason: error.reason, user: error.userID })
      return new NextResponse(error.message, { status: error.status })
    }
    return new NextResponse('Identity verification failed.', { status: 401 })
  }
}
