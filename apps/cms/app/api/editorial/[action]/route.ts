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
