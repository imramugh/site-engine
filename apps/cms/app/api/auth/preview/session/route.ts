import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { serverSessionStrategy } from '../../../../../src/identity'

export const dynamic = 'force-dynamic'

const previewRoles = new Set(['owner', 'approver', 'editor'])
const headers = { 'Cache-Control': 'no-store' }

function response(status: 204 | 401 | 403): Response {
  return new Response(null, { status, headers })
}

/** Internal Nginx auth_request check for the protected draft-preview upstream. */
export async function GET(request: Request): Promise<Response> {
  try {
    const payload = await getPayload({ config })
    const result = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    const user = result.user
    if (!user) return response(401)
    const roles = (user as { roles?: string[] }).roles
    return roles?.some((role) => previewRoles.has(role)) ? response(204) : response(403)
  } catch {
    return response(401)
  }
}
