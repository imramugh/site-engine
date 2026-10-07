import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import config from '../../../../payload.config'
import { acceptedTOTPCounter, decryptSecret, recoveryHash } from '../../../../src/totp'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_ABSOLUTE_SECONDS, SESSION_COOKIE } from '../../../../src/identity'
import { auditIdentityDecision } from '../../../../src/identity-audit'
import { isRetryableSQLiteError } from '../../../../src/sqlite'

const noStore = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const denied = () => noStore({ error: 'Invitation is invalid or expired.' }, 403)
const validCode = (value: unknown): value is string => typeof value === 'string' && /^\d{6}$/.test(value)

function sameOrigin(request: Request): boolean {
  const origin = process.env.PAYLOAD_PUBLIC_SERVER_URL
  return Boolean(origin && request.headers.get('origin') === new URL(origin).origin)
}

async function body(request: Request): Promise<Record<string, unknown> | undefined> {
  const text = await request.text()
  if (Buffer.byteLength(text) > 2048) return undefined
  try { const value: unknown = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined } catch { return undefined }
}

async function invitationForToken(payload: Payload, token: string, req?: PayloadRequest) {
  const invitations = await payload.find({ collection: 'invitations', where: { and: [{ provider: { equals: 'local' } }, { tokenHash: { equals: hashOpaqueToken(token) } }] }, limit: 1, depth: 0, overrideAccess: true, ...(req ? { req } : {}) })
  const invitation = invitations.docs[0]
  if (!invitation || invitation.acceptedAt || Date.parse(invitation.expiresAt) <= Date.now() || !invitation.pendingTotpSecret) return undefined
  return invitation
}

/** The opaque token is deliberately sent in the request body. Invitation URLs
 * use a fragment so web servers and proxies never receive it as request text. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return noStore({ error: 'CSRF origin check failed.' }, 403)
  const input = await body(request)
  if (!input || typeof input.token !== 'string' || input.token.length < 20 || input.token.length > 200) return noStore({ error: 'Invalid enrollment request.' }, 400)
  let payload: Payload
  try { payload = await getPayload({ config }) } catch { return noStore({ error: 'Enrollment is temporarily unavailable.' }, 503) }
  if (input.action === 'prepare') {
    let invitation
    try { invitation = await invitationForToken(payload, input.token) } catch { return noStore({ error: 'Enrollment is temporarily unavailable.' }, 503) }
    if (!invitation) return denied()
    const pendingTotpSecret = invitation.pendingTotpSecret
    if (!pendingTotpSecret) return denied()
    let seed: string
    try { seed = decryptSecret(pendingTotpSecret) } catch { return denied() }
    const label = `Site Engine:${encodeURIComponent(invitation.email)}`
    const otpauthURI = `otpauth://totp/${label}?secret=${seed}&issuer=Site%20Engine`
    return noStore({ email: invitation.email, roles: invitation.roles, otpauthURI })
  }
  if (input.action !== 'confirm' || !validCode(input.code) || typeof input.name !== 'string') return noStore({ error: 'Invalid enrollment request.' }, 400)
  const name = input.name.trim()
  if (!name || name.length > 160) return noStore({ error: 'Enter a valid name.' }, 400)
  let transactionID: string | number | null
  try { transactionID = await payload.db.beginTransaction() } catch { return noStore({ error: 'Enrollment is temporarily unavailable.' }, 503) }
  if (!transactionID) return noStore({ error: 'Enrollment is temporarily unavailable.' }, 503)
  const req = await createLocalReq({ req: { transactionID } }, payload)
  try {
    let invitation
    try { invitation = await invitationForToken(payload, input.token, req) } catch { await payload.db.rollbackTransaction(transactionID); return noStore({ error: 'Enrollment is temporarily unavailable.' }, 503) }
    if (!invitation) { await payload.db.rollbackTransaction(transactionID); return denied() }
    const pendingTotpSecret = invitation.pendingTotpSecret
    if (!pendingTotpSecret) { await payload.db.rollbackTransaction(transactionID); return denied() }
    let seed: string
    try { seed = decryptSecret(pendingTotpSecret) } catch { await payload.db.rollbackTransaction(transactionID); return denied() }
    const nowMillis = Date.now()
    if ((invitation.enrollmentFailedCount || 0) >= 5 && invitation.enrollmentFailedAt && nowMillis - Date.parse(invitation.enrollmentFailedAt) < 15 * 60_000) { await payload.db.rollbackTransaction(transactionID); return noStore({ error: 'Enrollment temporarily locked.' }, 429) }
    const counter = acceptedTOTPCounter(seed, input.code, nowMillis)
    if (counter === null) {
      const expiredWindow = !invitation.enrollmentFailedAt || nowMillis - Date.parse(invitation.enrollmentFailedAt) >= 15 * 60_000
      await payload.update({ collection: 'invitations', id: invitation.id, data: { enrollmentFailedCount: expiredWindow ? 1 : (invitation.enrollmentFailedCount || 0) + 1, enrollmentFailedAt: new Date(nowMillis).toISOString() }, overrideAccess: true, req })
      await payload.db.commitTransaction(transactionID)
      return noStore({ error: 'Authenticator code was not accepted.' }, 403)
    }
    const existing = await payload.find({ collection: 'users', where: { email: { equals: invitation.email } }, limit: 1, depth: 0, overrideAccess: true, req })
    if (existing.docs[0]) { await payload.db.rollbackTransaction(transactionID); return denied() }
    const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(10).toString('base64url'))
    const now = new Date(nowMillis).toISOString()
    const user = await payload.create({ collection: 'users', data: { email: invitation.email, name, roles: invitation.roles, invitedAt: now, provider: 'local', providerIssuer: 'local', providerSubject: `local:${newOpaqueToken()}`, emergencyTotpSecret: pendingTotpSecret, emergencyRecoveryHashes: recoveryCodes.map(recoveryHash), emergencyLastCounter: counter, emergencyFailedCount: 0 }, overrideAccess: true, req })
    const redeemed = await payload.update({ collection: 'invitations', where: { and: [{ id: { equals: invitation.id } }, { acceptedAt: { equals: null } }] }, data: { acceptedAt: now, pendingTotpSecret: null }, overrideAccess: true, req })
    if (redeemed.docs.length !== 1) throw new Error('Invitation redemption race.')
    const token = newOpaqueToken()
    await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(nowMillis + SESSION_ABSOLUTE_SECONDS * 1000).toISOString() }, overrideAccess: true, req })
    await auditIdentityDecision({ payload, req, event: 'identity.local_enrolled', user: user.id, provider: 'local' })
    await payload.db.commitTransaction(transactionID)
    const response = noStore({ recoveryCodes })
    response.cookies.set(cookieName(SESSION_COOKIE), token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: SESSION_ABSOLUTE_SECONDS })
    return response
  } catch (error) {
    await payload.db.rollbackTransaction(transactionID)
    return noStore({ error: isRetryableSQLiteError(error) ? 'Enrollment is temporarily unavailable.' : 'Enrollment could not be completed.' }, 503)
  }
}
