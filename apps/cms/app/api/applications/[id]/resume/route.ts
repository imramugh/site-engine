import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { cookieName, readCookie, serverSessionStrategy, SESSION_COOKIE } from '../../../../../src/identity'
import { readResume } from '../../../../../src/applications'
import { verifyResumeLink } from '../../../../../src/resume-links'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const payload = await getPayload({ config })
  const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  const roles = auth.user && (auth.user as { roles?: string[] }).roles; const { id } = await context.params; const token = readCookie(request.headers, cookieName(SESSION_COOKIE)); const signed = new URL(request.url).searchParams.get('token')
  if (!auth.user || !token || !roles?.some((role) => role === 'owner' || role === 'hiring') || (signed && !verifyResumeLink(signed, id, String(auth.user.id), token))) return new Response(null, { status: 403 })
  try {
    const application = await payload.findByID({ collection: 'applications', id, user: auth.user, overrideAccess: false }) as { resumeKey: string }
    const bytes = await readResume(application.resumeKey)
    return new Response(new Uint8Array(bytes), { headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="resume"',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    } })
  } catch {
    return new Response(null, { status: 404 })
  }
}
