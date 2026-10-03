import { createHmac, timingSafeEqual } from 'node:crypto'
import { hashOpaqueToken } from './identity'

type Claims = { applicationID: string; userID: string; sessionHash: string; expiresAt: number }
const encode = (value: Claims) => Buffer.from(JSON.stringify(value)).toString('base64url')
const secret = () => { const value = process.env.PAYLOAD_SECRET; if (!value) throw new Error('PAYLOAD_SECRET is required for resume links.'); return value }
const signature = (body: string) => createHmac('sha256', secret()).update(body).digest('base64url')

export function mintResumeLink(applicationID: string, userID: string, sessionToken: string, now = Date.now()): string {
  const body = encode({ applicationID, userID, sessionHash: hashOpaqueToken(sessionToken), expiresAt: now + 5 * 60_000 })
  return `${body}.${signature(body)}`
}

export function verifyResumeLink(token: string | null, applicationID: string, userID: string, sessionToken: string, now = Date.now()): boolean {
  if (!token) return false
  const [body, supplied] = token.split('.')
  if (!body || !supplied || token.split('.').length !== 2) return false
  const expected = signature(body); const left = Buffer.from(supplied); const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false
  try { const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Claims; return claims.applicationID === applicationID && claims.userID === userID && claims.sessionHash === hashOpaqueToken(sessionToken) && Number.isFinite(claims.expiresAt) && claims.expiresAt > now } catch { return false }
}
