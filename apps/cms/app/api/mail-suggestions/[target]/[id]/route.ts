import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { hasRole } from '../../../../../src/access'
import { cookieName, readCookie, serverSessionStrategy, SESSION_COOKIE } from '../../../../../src/identity'
import { adoptMailConversationSuggestion } from '../../../../../src/mail-conversation-suggestions'
const headers = { 'Cache-Control': 'no-store' }
async function auth(request: Request, target: string, id: string) {
  if (target !== 'lead' && target !== 'application') return undefined
  const payload = await getPayload({ config }); const session = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); const user = session.user as { id: string; roles?: string[] } | null
  if (!user || !hasRole(user as never, target === 'lead' ? ['owner', 'sales'] : ['owner', 'hiring'])) return undefined
  try { await payload.findByID({ collection: target === 'lead' ? 'inquiries' : 'applications', id, depth: 0, overrideAccess: false, user: user as never }) } catch { return undefined }
  return { payload, user }
}
export async function GET(request: Request, context: { params: Promise<{ target: string; id: string }> }) {
  const { target, id } = await context.params; const state = await auth(request, target, id); if (!state) return Response.json({ error: 'Not found.' }, { status: 404, headers })
  const record = await state.payload.findByID({ collection: target === 'lead' ? 'inquiries' : 'applications', id, depth: 0, overrideAccess: true }) as { email?: string }
  const suggestions = await state.payload.find({ collection: 'mail-conversation-suggestions', where: { and: [{ target: { equals: target } }, { sender: { equals: String(record.email ?? '').toLowerCase() } }, { adoptedAt: { exists: false } }] }, limit: 20, sort: '-createdAt', depth: 0, overrideAccess: true })
  return Response.json({ suggestions: suggestions.docs.map(item => ({ id: item.id, subject: item.subject, receivedFrom: item.sender })) }, { headers })
}
export async function POST(request: Request, context: { params: Promise<{ target: string; id: string }> }) {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; if (!configured || request.headers.get('origin') !== new URL(configured).origin) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers })
  const { target, id } = await context.params; const state = await auth(request, target, id); if (!state) return Response.json({ error: 'Not found.' }, { status: 404, headers })
  const body = await request.json().catch(() => null) as { suggestionID?: unknown } | null
  if (!body || typeof body.suggestionID !== 'string') return Response.json({ error: 'Invalid suggestion.' }, { status: 422, headers })
  try { const thread = await adoptMailConversationSuggestion(state.payload, { suggestionID: body.suggestionID, target: target as 'lead' | 'application', targetID: id, actor: state.user.id }); return Response.json({ thread: { id: thread.id } }, { headers }) } catch { return Response.json({ error: 'Suggestion cannot be adopted.' }, { status: 422, headers }) }
}
