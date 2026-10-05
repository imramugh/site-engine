import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { hasRole } from '../../../../../src/access'
import { serverSessionStrategy } from '../../../../../src/identity'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store' }

export async function GET(request: Request, context: { params: Promise<{ target: string; id: string }> }) {
  const { target, id } = await context.params
  if (target !== 'lead' && target !== 'application') return Response.json({ error: 'Not found.' }, { status: 404, headers })
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return Response.json({ error: 'Not found.' }, { status: 404, headers })
  const payload = await getPayload({ config })
  const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  const user = auth.user as { roles?: string[] } | null
  if (!user || !hasRole(user as never, target === 'lead' ? ['owner', 'sales'] : ['owner', 'hiring'])) return Response.json({ error: 'Authentication required.' }, { status: 403, headers })
  try { await payload.findByID({ collection: target === 'lead' ? 'inquiries' : 'applications', id, depth: 0, overrideAccess: false, user: user as never }) } catch { return Response.json({ error: 'Not found.' }, { status: 404, headers }) }
  let threads
  try { threads = await payload.find({ collection: 'mail-threads', where: { [target]: { equals: id } }, limit: 100, depth: 0, overrideAccess: false, user: user as never }) } catch { return Response.json({ error: 'Mail history unavailable.' }, { status: 503, headers }) }
  const ids = threads.docs.map(thread => thread.id)
  if (!ids.length) return Response.json({ messages: [] }, { headers })
  const messages = await payload.find({ collection: 'mail-thread-messages', where: { thread: { in: ids } }, limit: 500, sort: 'receivedAt', depth: 0, overrideAccess: false, user: user as never })
  return Response.json({ messages: messages.docs.map(message => ({ id: message.id, direction: message.direction, sender: message.sender, recipient: message.recipient, subject: message.subject, body: message.body, receivedAt: message.receivedAt, attachments: Array.isArray(message.attachmentMetadata) ? message.attachmentMetadata.map(item => ({ name: String((item as { name?: unknown }).name ?? ''), contentType: String((item as { contentType?: unknown }).contentType ?? ''), size: Number((item as { size?: unknown }).size ?? 0) })).slice(0, 20) : [] })) }, { headers })
}
