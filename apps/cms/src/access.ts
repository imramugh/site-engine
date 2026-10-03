import type { Access, AccessResult } from 'payload'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const roles = ['owner', 'approver', 'editor', 'sales', 'hiring'] as const
export type Role = (typeof roles)[number]

type Actor = { roles?: Role[]; disabled?: boolean } | undefined

export const hasRole = (actor: Actor, allowed: readonly Role[]) =>
  Boolean(actor && !actor.disabled && actor.roles?.some((role) => allowed.includes(role)))

export const staff = (allowed: readonly Role[]): Access => ({ req }): AccessResult =>
  hasRole(req.user as Actor, allowed)

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
