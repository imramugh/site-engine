import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { withPayloadTransaction } from '../../../../src/auth-transaction'
import { createNamedChangeSet, transitionChangeSet } from '../../../../src/editorial'
import { serverSessionStrategy } from '../../../../src/identity'

export const dynamic = 'force-dynamic'

function sameOrigin(request: Request): boolean {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  return Boolean(configured && origin && origin === new URL(configured).origin)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Editorial workflow request failed.'
}

/** Server-owned lifecycle API. Collection REST updates are denied so clients
 * cannot forge state, actor, baseline, or review timestamps. */
export async function POST(request: Request, context: { params: Promise<{ action: string }> }): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403 })
  try {
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    if (!authenticated.user) return Response.json({ error: 'Authentication required.' }, { status: 401 })
    const body = await request.json() as { id?: string; name?: string }
    const { action } = await context.params
    const result = await withPayloadTransaction(payload, async (req) => {
      req.user = authenticated.user
      if (action === 'create') {
        if (typeof body.name !== 'string') throw new Error('A change-set name is required.')
        return createNamedChangeSet(payload, req, authenticated.user as never, body.name)
      }
      if (action === 'comment' && typeof body.id === 'string' && typeof (body as { comment?: unknown }).comment === 'string') {
        const actor = authenticated.user as { id: string; roles?: string[] }
        if (!actor.roles?.some((role) => role === 'owner' || role === 'approver')) throw new Error('Reviewer role required.')
        const comment = (body as { comment: string }).comment.trim()
        if (!comment || comment.length > 2_000) throw new Error('A review comment must contain at most 2,000 characters.')
        const set = await payload.findByID({ collection: 'change-sets', id: body.id, depth: 0, overrideAccess: true, req })
        const comments = Array.isArray(set.reviewComments) ? set.reviewComments : []
        return payload.update({ collection: 'change-sets', id: body.id, data: { reviewComments: [...comments, { id: crypto.randomUUID(), author: actor.id, body: comment, createdAt: new Date().toISOString() }] }, overrideAccess: true, req, context: { editorialInternal: true } })
      }
      if (!['submit', 'request-changes', 'reject', 'discard', 'refresh'].includes(action) || typeof body.id !== 'string') throw new Error('Unknown workflow action or missing change-set ID.')
      return transitionChangeSet({ payload, req, actor: authenticated.user as never, id: body.id, action: action as 'submit' | 'request-changes' | 'reject' | 'discard' | 'refresh' })
    })
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const text = message(error)
    const status = /Authentication|required|role|required|Only the editor/i.test(text) ? 403 : 400
    return Response.json({ error: text }, { status })
  }
}

export async function GET(request: Request, context: { params: Promise<{ action: string }> }): Promise<Response> {
  const { action } = await context.params
  if (action !== 'list') return Response.json({ error: 'Unknown editorial resource.' }, { status: 404 })
  try {
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    if (!authenticated.user) return Response.json({ error: 'Authentication required.' }, { status: 401 })
    const actor = authenticated.user as { id: string; roles?: string[] }
    const result = await payload.find({ collection: 'change-sets', limit: 100, depth: 0, user: authenticated.user, overrideAccess: false })
    return Response.json({ sets: result.docs, actor: { id: actor.id, roles: actor.roles ?? [] } }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return Response.json({ error: 'Unable to load change sets.' }, { status: 403 })
  }
}
