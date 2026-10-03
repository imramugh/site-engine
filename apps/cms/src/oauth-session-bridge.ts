import { timingSafeEqual } from 'node:crypto'
import type { Payload } from 'payload'
import type { AuthSession, User } from '../payload-types'
import { cookieName, hashOpaqueToken, readCookie, SESSION_COOKIE, sessionIsUsable } from './identity'

const MAX_BODY_BYTES = 4_096
const contentRead = 'mcp:content:read'
const contentWrite = 'mcp:content:write'
const redirectsRead = 'mcp:redirects:read'
const redirectsWrite = 'mcp:redirects:write'

export type OAuthBridgeUser = { id: string; sessionId: string; scopes: readonly string[] }
type BridgeRequest = { operation: 'resolve' } | { operation: 'validate'; sessionId: string; userId: string }

function scopesForRoles(roles: readonly string[] | null | undefined): string[] {
  if (roles?.includes('owner') || roles?.includes('editor')) return [contentRead, contentWrite, redirectsRead, redirectsWrite]
  if (roles?.includes('approver')) return [contentRead, redirectsRead]
  return []
}

function relationId(value: AuthSession['user']): string | undefined {
  return typeof value === 'string' ? value : value?.id
}

function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  if (input.operation === 'resolve') return Object.keys(input).length === 1
  return input.operation === 'validate'
    && Object.keys(input).length === 3
    && typeof input.sessionId === 'string' && input.sessionId.length > 0 && input.sessionId.length <= 128
    && typeof input.userId === 'string' && input.userId.length > 0 && input.userId.length <= 128
}

function secretMatches(request: Request, expected: string | undefined): boolean {
  const supplied = request.headers.get('x-oauth-bridge-secret')
  if (!expected || !supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function response(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

async function requestBody(request: Request): Promise<BridgeRequest | undefined> {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) return undefined
  const reader = request.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > MAX_BODY_BYTES) { await reader.cancel(); return undefined }
      chunks.push(part.value)
    }
  } catch { return undefined }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return isBridgeRequest(value) ? value : undefined
  } catch {
    return undefined
  }
}

async function activeUser(payload: Payload, session: AuthSession, expectedUserId?: string): Promise<OAuthBridgeUser | undefined> {
  const userId = relationId(session.user)
  if (!userId || (expectedUserId && userId !== expectedUserId) || !sessionIsUsable(session)) return undefined
  try {
    const user = await payload.findByID({ collection: 'users', id: userId, overrideAccess: true }) as User
    if (user.disabled) return undefined
    return { id: user.id, sessionId: session.id, scopes: scopesForRoles(user.roles) }
  } catch {
    return undefined
  }
}

/**
 * Private, server-to-server bridge for OAuth. It deliberately returns no
 * profile fields: callers receive only a current user id, session id and the
 * effective MCP scopes derived from canonical CMS roles.
 */
export async function handleOAuthSessionBridge(request: Request, payload: Payload, secret = process.env.OAUTH_BRIDGE_SECRET): Promise<Response> {
  if (request.method !== 'POST') return response(405, { error: 'method_not_allowed' })
  if (!secretMatches(request, secret)) return response(401, { error: 'unauthorized' })
  if (!request.headers.get('content-type')?.startsWith('application/json')) return response(400, { error: 'invalid_request' })
  const body = await requestBody(request)
  if (!body) return response(400, { error: 'invalid_request' })

  let session: AuthSession | undefined
  if (body.operation === 'resolve') {
    const token = readCookie(request.headers, cookieName(SESSION_COOKIE))
    if (!token) return response(401, { error: 'unauthorized' })
    try {
      const result = await payload.find({ collection: 'auth-sessions', where: { tokenHash: { equals: hashOpaqueToken(token) } }, limit: 1, overrideAccess: true })
      session = result.docs[0] as AuthSession | undefined
    } catch { return response(401, { error: 'unauthorized' }) }
  } else {
    try { session = await payload.findByID({ collection: 'auth-sessions', id: body.sessionId, overrideAccess: true }) as AuthSession } catch { session = undefined }
  }
  const user = session ? await activeUser(payload, session, body.operation === 'validate' ? body.userId : undefined) : undefined
  if (!user) return response(401, { error: 'unauthorized' })
  return response(200, { user })
}
