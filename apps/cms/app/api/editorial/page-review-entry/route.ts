import { sqliteAuthenticationBoundary } from '../../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { freshStaff, hasRole } from '../../../../src/access'
import { serverSessionStrategy } from '../../../../src/identity'
import { canonicalReviewPath, pageReviewEntries } from '../../../../src/page-review-entry'

export const dynamic = 'force-dynamic'
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
const empty = (status: 200 | 401 | 403, headers: Record<string, string> = {}) => new Response(null, { status, headers: { ...privateHeaders, ...headers } })

async function GETHandler(request: Request): Promise<Response> {
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  const user = authenticated.user as { id?: string; roles?: ('owner' | 'approver' | 'editor' | 'sales' | 'hiring')[] } | null
  if (!user) return empty(401)
  if (!hasRole(user, ['owner', 'approver'])) return empty(403)
  const url = new URL(request.url)
  const internalPath = request.headers.get('x-original-uri')
  const requestedPath = canonicalReviewPath(internalPath ?? url.searchParams.get('path') ?? '')
  if (!requestedPath) return empty(403)
  const fresh = await freshStaff(['owner', 'approver'])({ req: { payload, user, headers: request.headers } as never }) === true
  const entries = await pageReviewEntries(payload, requestedPath, fresh)
  if (internalPath) {
    if (!entries.length) return empty(403)
    return empty(200, {
      'X-Page-Review-Set': entries[0]!.id,
      'X-Page-Review-Count': String(entries.length),
      'X-Page-Review-Path': requestedPath,
    })
  }
  if (!entries.length) return Response.json({ entries: [] }, { status: 403, headers: privateHeaders })
  return Response.json({ entries }, { headers: privateHeaders })
}

export const GET = sqliteAuthenticationBoundary(GETHandler)
