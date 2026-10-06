import { sqliteAuthenticationBoundary } from '../../../../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../../../../payload.config'
import { cookieName, readCookie, serverSessionStrategy, SESSION_COOKIE } from '../../../../../../src/identity'
import { mintResumeLink } from '../../../../../../src/resume-links'

export const dynamic = 'force-dynamic'
async function POSTHandler(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const origin = process.env.PAYLOAD_PUBLIC_SERVER_URL
  if (!origin || request.headers.get('origin') !== new URL(origin).origin) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403 })
  const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); const roles = auth.user && (auth.user as { roles?: string[] }).roles; const token = readCookie(request.headers, cookieName(SESSION_COOKIE))
  if (!auth.user || !token || !roles?.some((role) => role === 'owner' || role === 'hiring')) return Response.json({ error: 'Authentication required.' }, { status: 403 })
  try { const { id } = await context.params; await payload.findByID({ collection: 'applications', id, user: auth.user, overrideAccess: false }); return Response.json({ url: `/api/applications/${id}/resume?token=${encodeURIComponent(mintResumeLink(id, String(auth.user.id), token))}` }, { headers: { 'Cache-Control': 'no-store' } }) } catch { return Response.json({ error: 'Application not found.' }, { status: 404 }) }
}

export const POST = sqliteAuthenticationBoundary(POSTHandler)
