import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AuthStrategy, AuthStrategyFunctionArgs } from 'payload'
import type { AuthSession, User } from '../payload-types'

export const SESSION_COOKIE = '__Host-site_engine_session'
export const OIDC_TRANSACTION_COOKIE = '__Host-site_engine_oidc'
export const SESSION_IDLE_SECONDS = 8 * 60 * 60
export const SESSION_ABSOLUTE_SECONDS = 7 * 24 * 60 * 60
export const SENSITIVE_REAUTH_SECONDS = 15 * 60
export const OIDC_STATE_TTL_SECONDS = 10 * 60

export type IdentityProvider = 'google' | 'microsoft'

export const hashOpaqueToken = (value: string) => createHash('sha256').update(value).digest('base64url')
export const newOpaqueToken = () => randomBytes(32).toString('base64url')

export function readCookie(headers: Headers, name: string): string | undefined {
  const header = headers.get('cookie')
  return header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1)
}

export function cookieName(name: string): string {
  return process.env.NODE_ENV === 'production' ? name : name.replace('__Host-', '')
}

export function sessionIsUsable(session: { expiresAt: string; lastSeenAt: string; authenticatedAt?: string; revokedAt?: string | null }, now = Date.now()): boolean {
  const expires = Date.parse(session.expiresAt); const seen = Date.parse(session.lastSeenAt); const authenticated = session.authenticatedAt ? Date.parse(session.authenticatedAt) : NaN
  if (!Number.isFinite(expires) || !Number.isFinite(seen) || (session.authenticatedAt !== undefined && !Number.isFinite(authenticated))) return false
  if (session.revokedAt || expires <= now || seen + SESSION_IDLE_SECONDS * 1000 <= now) return false
  return !Number.isFinite(authenticated) || authenticated + SESSION_ABSOLUTE_SECONDS * 1000 > now
}

export function hasFreshAuthentication(session: { authenticatedAt: string }, now = Date.now()): boolean {
  const authenticated = Date.parse(session.authenticatedAt)
  return Number.isFinite(authenticated) && authenticated + SENSITIVE_REAUTH_SECONDS * 1000 > now
}

/** Payload custom strategy: every request checks the opaque session and current user in SQLite. */
export const serverSessionStrategy: AuthStrategy = {
  name: 'server-session',
  authenticate: async ({ headers, payload }: AuthStrategyFunctionArgs) => {
    const token = readCookie(headers, cookieName(SESSION_COOKIE))
    if (!token) return { user: null }
    const tokenHash = hashOpaqueToken(token)
    const sessions = await payload.find({
      collection: 'auth-sessions',
      where: { tokenHash: { equals: tokenHash } },
      limit: 1,
      overrideAccess: true,
    })
    const session = sessions.docs[0] as AuthSession | undefined
    if (!session || !sessionIsUsable(session)) return { user: null }
    const userID = typeof session.user === 'string' ? session.user : session.user?.id
    if (!userID) return { user: null }
    const user = await payload.findByID({ collection: 'users', id: userID, overrideAccess: true }) as User
    if (user.disabled) return { user: null }
    // Idle expiry is sliding, and the authoritative timestamp is in SQLite rather
    // than a JWT claim. Throttle the write while still refreshing active sessions.
    if (Date.now() - new Date(session.lastSeenAt).getTime() > 60_000) {
      await payload.update({ collection: 'auth-sessions', id: session.id, data: { lastSeenAt: new Date().toISOString() }, overrideAccess: true })
    }
    return { user: { ...user, collection: 'users', _strategy: 'server-session' } }
  },
}

export function equalOpaque(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
