import { NextResponse } from 'next/server'
import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { cookieName, hashOpaqueToken, newOpaqueToken, readCookie, OIDC_STATE_TTL_SECONDS, OIDC_TRANSACTION_COOKIE, type IdentityProvider } from '../../../../src/identity'
import { AuthStartThrottledError, createBoundedAuthTransaction } from '../../../../src/auth-rate-limit'
import { authorizationURL, configuredProvider } from '../../../../src/oidc'
import { isRetryableSQLiteError } from '../../../../src/sqlite'

const validProvider = (value: string): value is IdentityProvider => value === 'google' || value === 'microsoft'

const temporarilyUnavailable = () => new NextResponse('Sign-in is temporarily unavailable. Please try again.', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' } })

async function GETHandler(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params
  if (!validProvider(provider)) return new NextResponse('Not found', { status: 404 })
  const settings = configuredProvider(provider)
  if (!settings) return new NextResponse('This identity provider has not been configured.', { status: 503 })
  const invite = new URL(request.url).searchParams.get('invite')
  const state = newOpaqueToken()
  const nonce = newOpaqueToken()
  const verifier = newOpaqueToken()
  const payload = await getPayload({ config })
  const invitations = invite ? await payload.find({ collection: 'invitations', where: { and: [{ provider: { equals: provider } }, { tokenHash: { equals: hashOpaqueToken(invite) } }] }, limit: 1, overrideAccess: true }) : undefined
  const invitation = invitations?.docs[0]
  if (invite && (!invitation || invitation.acceptedAt || new Date(invitation.expiresAt).getTime() <= Date.now())) return new NextResponse('Invitation is invalid or expired.', { status: 403 })
  let transaction
  try {
    transaction = await createBoundedAuthTransaction(payload, {
      invitation: invitation?.id,
      nonce,
      previousStateHash: readCookie(request.headers, cookieName(OIDC_TRANSACTION_COOKIE)),
      provider,
      stateHash: hashOpaqueToken(state),
      verifier,
    })
  } catch (error) {
    if (error instanceof AuthStartThrottledError) return new NextResponse(error.message, { status: error.reason === 'capacity' ? 503 : 429, headers: { 'Retry-After': error.reason === 'capacity' ? '60' : '15' } })
    if (isRetryableSQLiteError(error)) return temporarilyUnavailable()
    return new NextResponse('Sign-in is temporarily unavailable.', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' } })
  }
  let authorization
  try {
    authorization = await authorizationURL(settings, state, nonce, verifier)
  } catch {
    await payload.delete({ collection: 'auth-transactions', id: transaction.id, overrideAccess: true })
    return new NextResponse('Sign-in is temporarily unavailable.', { status: 503, headers: { 'Retry-After': '1' } })
  }
  const response = NextResponse.redirect(authorization)
  response.cookies.set(cookieName(OIDC_TRANSACTION_COOKIE), hashOpaqueToken(state), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: OIDC_STATE_TTL_SECONDS })
  return response
}

/** A start has no provider side effect yet, so a contention response is safe
 * to retry. Keep the response free of a state cookie until the transaction is
 * durable. */
export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  try {
    return await GETHandler(request, context)
  } catch (error) {
    if (isRetryableSQLiteError(error)) return temporarilyUnavailable()
    throw error
  }
}
