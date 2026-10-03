import type { Access, AccessResult } from 'payload'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cookieName, hasFreshAuthentication, hashOpaqueToken, readCookie, SESSION_COOKIE, sessionIsUsable } from './identity'

export const roles = ['owner', 'approver', 'editor', 'sales', 'hiring'] as const
export type Role = (typeof roles)[number]

type Actor = { roles?: Role[] | null; disabled?: boolean | null } | undefined

export const hasRole = (actor: Actor, allowed: readonly Role[]) =>
  Boolean(actor && !actor.disabled && actor.roles?.some((role) => allowed.includes(role)))

export const staff = (allowed: readonly Role[]): Access => ({ req }): AccessResult =>
  hasRole(req.user as Actor, allowed)

/**
 * Sensitive identity changes require a recent, server-side session for the
 * same canonical user. Request user fields alone are never sufficient.
 */
export const freshStaff = (allowed: readonly Role[]): Access => async ({ req }) => {
  const requestUser = req.user as (Actor & { id?: string })
  if (!requestUser?.id) return false
  const token = readCookie(req.headers, cookieName(SESSION_COOKIE))
  if (!token) return false

  const sessions = await req.payload.find({
    collection: 'auth-sessions',
    where: { tokenHash: { equals: hashOpaqueToken(token) } },
    limit: 1,
    overrideAccess: true,
    req,
  })
  const session = sessions.docs[0]
  const sessionUserID = typeof session?.user === 'string' ? session.user : session?.user?.id
  if (!session || sessionUserID !== requestUser.id || !sessionIsUsable(session) || !hasFreshAuthentication(session)) return false

  try {
    const canonicalUser = await req.payload.findByID({ collection: 'users', id: sessionUserID, overrideAccess: true, req })
    return canonicalUser.id === requestUser.id && hasRole(canonicalUser as Actor, allowed)
  } catch {
    return false
  }
}

/** The bootstrap token is checked by the CLI before it creates a short-lived request context. */
export const bootstrapOnly: Access = ({ req }) => {
  const supplied = req.context.bootstrapOperatorToken
  const tokenFile = process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE
  let expected: string | undefined
  try { expected = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : undefined } catch { expected = undefined }
  if (typeof supplied !== 'string' || !expected) return false
  const suppliedBuffer = Buffer.from(supplied)
  const expectedBuffer = Buffer.from(expected)
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer)
}

export const ownerOrBootstrap: Access = ({ req }) =>
  hasRole(req.user as Actor, ['owner']) || bootstrapOnly({ req })

/** Staff can load their own profile (including Payload /me); Owners manage all users. */
export const ownerOrSelfOrBootstrap: Access = async ({ req }) => {
  if (await ownerOrBootstrap({ req })) return true
  if (!req.user || req.user.disabled) return false
  return { id: { equals: req.user.id } }
}
