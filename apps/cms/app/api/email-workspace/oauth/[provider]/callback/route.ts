import { getPayload } from 'payload'
import config from '../../../../../../payload.config'
import { hasRole } from '../../../../../../src/access'
import { cookieName, readCookie, SESSION_COOKIE, serverSessionStrategy } from '../../../../../../src/identity'
import { completeMailboxOAuth } from '../../../../../../src/mailbox-oauth'
import { isRetryableSQLiteError, sqliteAuthenticationBoundary } from '../../../../../../src/sqlite'

async function GETHandler(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const provider = (await params).provider
  const token = readCookie(request.headers, cookieName(SESSION_COOKIE))
  if (provider !== 'microsoft' && provider !== 'google') return new Response('Not found', { status: 404 })
  const payload = await getPayload({ config })
  const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  const user = auth.user as { id: string } | null
  const url = new URL(request.url)
  if (!user || !token || !hasRole(user as never, ['owner'])) return new Response('Owner session required.', { status: 403 })
  const integration = (status: 'connected' | 'authorization_failed') => new URL(`/integrations?tab=email&mailbox=${status}&provider=${provider}`, url.origin)
  try {
    await completeMailboxOAuth(payload, provider, url.searchParams.get('state') || '', url.searchParams.get('code') || '', user.id, token)
    return Response.redirect(integration('connected'), 302)
  } catch (error) {
    // The provider authorization code may already have been exchanged. A
    // SQLite retry cannot safely replay it, so require a new authorization.
    if (isRetryableSQLiteError(error)) return new Response('Mailbox authorization could not be saved. Please restart authorization.', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' } })
    return Response.redirect(integration('authorization_failed'), 302)
  }
}

export const GET = sqliteAuthenticationBoundary(GETHandler)
