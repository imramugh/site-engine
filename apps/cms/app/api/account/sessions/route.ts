import { NextResponse } from 'next/server'
import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { cookieName, readCookie, serverSessionStrategy, SESSION_COOKIE } from '../../../../src/identity'
import { loadAccountSessions, revokeAccountSessions, UserManagementError } from '../../../../src/user-management'

export const dynamic = 'force-dynamic'
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const sameOrigin = (request: Request) => { const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; const origin = request.headers.get('origin'); return Boolean(configured && origin && origin === new URL(configured).origin) }
async function context(request: Request) { const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); return { payload, user: auth.user as { id: string; name?: string; email?: string; roles?: string[]; provider?: string } | null } }
async function body(request: Request): Promise<{ action?: unknown; sessionID?: unknown }> { const text = await request.text(); if (Buffer.byteLength(text) > 4096) throw new Error('large'); const value: unknown = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body'); return value }
export async function GET(request: Request) {
  const { payload, user } = await context(request)
  if (!user) return json({ error: 'Sign in required.' }, 401)
  const token = readCookie(request.headers, cookieName(SESSION_COOKIE))
  return json({ account: { id: user.id, name: user.name, email: user.email, roles: user.roles ?? [], provider: user.provider ?? null }, sessions: await loadAccountSessions(payload, user.id, token) })
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'CSRF origin check failed.' }, 403)
  try {
    const { payload, user } = await context(request)
    if (!user) return json({ error: 'Sign in required.' }, 401)
    const input = await body(request)
    const current = await loadAccountSessions(payload, user.id, readCookie(request.headers, cookieName(SESSION_COOKIE)))
    const all = input.action === 'revoke-all'
    if (!all && (input.action !== 'revoke' || typeof input.sessionID !== 'string')) return json({ error: 'Choose a session to revoke.' }, 400)
    const currentRevoked = all || current.some((session) => session.id === input.sessionID && session.current)
    await revokeAccountSessions(payload, user, all ? { all: true } : { sessionID: input.sessionID as string })
    const response = json({ revoked: true, signedOut: currentRevoked })
    if (currentRevoked) response.cookies.delete(cookieName(SESSION_COOKIE))
    return response
  } catch (error) { return json({ error: error instanceof UserManagementError ? error.message : 'The session request could not be completed.' }, error instanceof UserManagementError && error.code === 'not-found' ? 404 : 400) }
}
