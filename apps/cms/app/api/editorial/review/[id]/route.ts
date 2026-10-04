import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { freshStaff, hasRole } from '../../../../../src/access'
import { serverSessionStrategy } from '../../../../../src/identity'
import { loadReviewModeData } from '../../../../../src/review-mode'

export const dynamic = 'force-dynamic'
const privateHeaders = { 'Cache-Control': 'private, no-store' }

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    const user = authenticated.user as { id?: string; roles?: ('owner' | 'approver' | 'editor' | 'sales' | 'hiring')[]; disabled?: boolean } | null
    if (!user) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: privateHeaders })
    if (!hasRole(user, ['owner', 'approver'])) return Response.json({ error: 'Reviewer role required.' }, { status: 403, headers: privateHeaders })
    const { id } = await context.params
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return Response.json({ error: 'A valid change set is required.' }, { status: 400, headers: privateHeaders })
    const pageID = new URL(request.url).searchParams.get('pageID') ?? undefined
    if (pageID && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pageID)) return Response.json({ error: 'A valid review page is required.' }, { status: 400, headers: privateHeaders })
    const review = await loadReviewModeData(payload, id, { pageID })
    const fresh = await freshStaff(['owner', 'approver'])({ req: { payload, user, headers: request.headers } as never })
    return Response.json({ review, fresh }, { headers: privateHeaders })
  } catch (error) {
    const text = error instanceof Error ? error.message : 'Unable to load this review.'
    const status = /no longer current|ready comparison/i.test(text) ? 409 : /not found/i.test(text) ? 404 : 400
    return Response.json({ error: text }, { status, headers: privateHeaders })
  }
}
