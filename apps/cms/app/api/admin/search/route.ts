import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { serverSessionStrategy } from '../../../../src/identity'
import { boundedSearchQuery, searchAdminRecords } from '../../../../src/admin-search'

export const dynamic = 'force-dynamic'

function sameOrigin(request: Request) {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  return Boolean(configured && (origin === new URL(configured).origin || (!origin && request.headers.get('sec-fetch-site') === 'same-origin')))
}

export async function GET(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Same-origin request required.' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  const user = authenticated.user as { id?: string; roles?: ('owner' | 'editor' | 'approver' | 'sales' | 'hiring')[]; disabled?: boolean } | null
  if (!user) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
  const query = boundedSearchQuery(new URL(request.url).searchParams.get('q'))
  if (!query) return Response.json({ error: 'Use 2 to 80 search characters.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  try {
    return Response.json(await searchAdminRecords(payload, user, query), { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return Response.json({ error: 'Search is unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
