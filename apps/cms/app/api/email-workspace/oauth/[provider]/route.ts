import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { freshStaff, hasRole } from '../../../../../src/access'
import { cookieName, readCookie, SESSION_COOKIE, serverSessionStrategy } from '../../../../../src/identity'
import { startMailboxOAuth } from '../../../../../src/mailbox-oauth'
import { isRetryableSQLiteError, sqliteAuthenticationBoundary } from '../../../../../src/sqlite'

const temporarilyUnavailable = () => new Response('Mailbox authorization is temporarily unavailable. Please restart authorization.', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' } })

async function GETHandler(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const provider = (await params).provider
  const token = readCookie(request.headers, cookieName(SESSION_COOKIE))
  if (provider !== 'microsoft' && provider !== 'google') return new Response('Not found', { status: 404 })
  const payload = await getPayload({ config })
  const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  const user = auth.user as { id: string } | null
  if (!user || !token || !hasRole(user as never, ['owner']) || !(await freshStaff(['owner'])({ req: { payload, user, headers: request.headers } as never }))) return new Response('Fresh Owner authentication is required.', { status: 403 })
  try {
    return Response.redirect(await startMailboxOAuth(payload, provider, user.id, token), 302)
  } catch (error) {
    if (isRetryableSQLiteError(error)) return temporarilyUnavailable()
    return new Response('Mailbox provider is not configured.', { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
export const GET = sqliteAuthenticationBoundary(GETHandler)
