import { NextResponse } from 'next/server'
import { createLocalReq, getPayload } from 'payload'
import config from '../../../../payload.config'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE, SESSION_ABSOLUTE_SECONDS } from '../../../../src/identity'
import { decryptSecret, recoveryMatches, acceptedTOTPCounter } from '../../../../src/totp'
import { auditEmergencyDenial, auditIdentityDecision } from '../../../../src/identity-audit'
import { isRetryableSQLiteError } from '../../../../src/sqlite'

/** All credential consumption, rate limits, sessions and audit writes share one transaction. */
export async function POST(request: Request) {
  const origin = process.env.PAYLOAD_PUBLIC_SERVER_URL
  if (!origin || request.headers.get('origin') !== new URL(origin).origin) return new NextResponse('CSRF origin check failed.', { status: 403 })
  const text = await request.text()
  if (text.length > 2048) return new NextResponse('Request is too large.', { status: 413 })
  let body: { email?: unknown; code?: unknown }
  try { body = JSON.parse(text) } catch { return new NextResponse('Invalid request.', { status: 400 }) }
  if (!body || typeof body.email !== 'string' || body.email.length > 254 || typeof body.code !== 'string' || !/^[A-Za-z0-9_-]{6,128}$/.test(body.code)) return new NextResponse('Invalid request.', { status: 400 })
  const email = body.email.trim().toLowerCase()
  const code = body.code
  const payload = await getPayload({ config })
  let transactionID: string | number | null
  try { transactionID = await payload.db.beginTransaction() } catch {
    return new NextResponse('Authentication is temporarily unavailable.', { status: 503, headers: { 'Retry-After': '1' } })
  }
  if (!transactionID) return new NextResponse('Authentication is temporarily unavailable.', { status: 503 })
  const req = await createLocalReq({ req: { transactionID } }, payload)
  try {
    const found = await payload.find({ collection: 'users', where: { email: { equals: email } }, limit: 1, overrideAccess: true, req })
    const user = found.docs[0]
    const now = Date.now()
    if (!user) {
      await payload.db.rollbackTransaction(transactionID)
      return new NextResponse('Emergency authentication denied.', { status: 403 })
    }
    if (user.disabled || !user.roles.includes('owner') || !user.emergencyTotpSecret) {
      await auditEmergencyDenial(payload, { req, user: user.id, reason: user.disabled ? 'account_disabled' : 'account_not_eligible', now })
      await payload.db.commitTransaction(transactionID)
      return new NextResponse('Emergency authentication denied.', { status: 403 })
    }
    if ((user.emergencyFailedCount || 0) >= 5 && user.emergencyFailedAt && now - Date.parse(user.emergencyFailedAt) < 15 * 60_000) {
      await payload.db.rollbackTransaction(transactionID)
      return new NextResponse('Emergency authentication temporarily locked.', { status: 429, headers: { 'Retry-After': '900' } })
    }
    const recoveryHashes = Array.isArray(user.emergencyRecoveryHashes) ? [...user.emergencyRecoveryHashes] : []
    const recovery = recoveryHashes.findIndex((hash) => typeof hash === 'string' && recoveryMatches(code, hash))
    const counter = acceptedTOTPCounter(decryptSecret(user.emergencyTotpSecret), code, now)
    const totpOK = counter !== null && counter > (user.emergencyLastCounter ?? -1)
    if (!totpOK && recovery < 0) {
      const expiredWindow = !user.emergencyFailedAt || now - Date.parse(user.emergencyFailedAt) >= 15 * 60_000
      await payload.update({ collection: 'users', id: user.id, data: { emergencyFailedCount: expiredWindow ? 1 : (user.emergencyFailedCount || 0) + 1, emergencyFailedAt: new Date(now).toISOString() }, overrideAccess: true, req })
      await auditIdentityDecision({ payload, req, event: 'identity.emergency_denied', user: user.id, provider: 'local', reason: 'invalid_credential' })
      await payload.db.commitTransaction(transactionID)
      return new NextResponse('Emergency authentication denied.', { status: 403 })
    }
    if (recovery >= 0) recoveryHashes.splice(recovery, 1)
    await payload.update({ collection: 'users', id: user.id, data: { ...(totpOK ? { emergencyLastCounter: counter } : {}), emergencyRecoveryHashes: recoveryHashes, emergencyFailedCount: 0, emergencyFailedAt: null }, overrideAccess: true, req })
    const token = newOpaqueToken()
    await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_ABSOLUTE_SECONDS * 1000).toISOString() }, overrideAccess: true, req })
    await auditIdentityDecision({ payload, req, event: 'identity.emergency_signed_in', user: user.id, provider: 'local' })
    await payload.db.commitTransaction(transactionID)
    const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
    response.cookies.set(cookieName(SESSION_COOKIE), token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: SESSION_ABSOLUTE_SECONDS })
    return response
  } catch (error) {
    await payload.db.rollbackTransaction(transactionID)
    return new NextResponse('Authentication is temporarily unavailable.', { status: 503, headers: isRetryableSQLiteError(error) ? { 'Retry-After': '1' } : undefined })
  }
}
