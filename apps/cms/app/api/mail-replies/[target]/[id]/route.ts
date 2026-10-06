import { sqliteAuthenticationBoundary } from '../../../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { hasRole } from '../../../../../src/access'
import { cookieName, readCookie, serverSessionStrategy, SESSION_COOKIE } from '../../../../../src/identity'
import { authorizeReply, cancelReply, prepareReply, sendReply } from '../../../../../src/mail-replies'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../../../src/sqlite'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }
async function GETHandler(request: Request, context: { params: Promise<{ target: string; id: string }> }) {
  const { target, id } = await context.params; if (target !== 'lead' && target !== 'application') return Response.json({ error: 'Unknown mail target.' }, { status: 404, headers: noStore })
  const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); const user = auth.user as { id: string; roles?: string[] } | null
  if (!user || !hasRole(user as never, target === 'lead' ? ['owner', 'sales'] : ['owner', 'hiring'])) return Response.json({ error: 'Authentication required.' }, { status: 403, headers: noStore })
  try { await payload.findByID({ collection: target === 'lead' ? 'inquiries' : 'applications', id, depth: 0, overrideAccess: false, user: user as never }) } catch { return Response.json({ error: 'Record not found.' }, { status: 404, headers: noStore }) }
  const area = target === 'lead' ? 'leads' : 'careers'; const mapping = await payload.find({ collection: 'mailbox-area-mappings', where: { area: { equals: area } }, limit: 1, depth: 0, overrideAccess: true })
  if (!mapping.docs[0]) return Response.json({ senders: [], threads: [], preparedDraft: null, canAuthorize: user.roles?.includes('owner') === true }, { headers: noStore })
  const mailboxID = typeof mapping.docs[0].mailbox === 'string' ? mapping.docs[0].mailbox : mapping.docs[0].mailbox.id
  const mailbox = await payload.findByID({ collection: 'mailbox-configurations', id: mailboxID, depth: 0, overrideAccess: true })
  const address = String(mapping.docs[0].senderAddress).toLowerCase(); const verified = mailbox.health === 'connected' && (String(mailbox.primaryAddress).toLowerCase() === address || (Array.isArray(mailbox.verifiedAliases) && mailbox.verifiedAliases.map(String).includes(address)))
  let threads: Array<{ id: string; subject: string }> = []
  if (verified && (mailbox.provider === 'google' || mailbox.provider === 'microsoft')) {
    const found = await payload.find({ collection: 'mail-threads', where: { and: [{ [target]: { equals: id } }, { mailbox: { equals: mailboxID } }, { provider: { equals: mailbox.provider } }] }, limit: 50, sort: '-updatedAt', depth: 0, overrideAccess: true })
    threads = await Promise.all(found.docs.map(async (thread) => {
      const message = await payload.find({ collection: 'mail-thread-messages', where: { thread: { equals: thread.id } }, limit: 1, sort: '-receivedAt', depth: 0, overrideAccess: true })
      return message.docs[0] ? { id: String(thread.providerConversationID), subject: String(message.docs[0].subject) } : undefined
    })).then(items => items.filter((item): item is { id: string; subject: string } => Boolean(item)))
  }
  const prepared = await payload.find({ collection: 'mail-drafts', where: { and: [{ [target]: { equals: id } }, { state: { equals: 'prepared' } }] }, sort: '-updatedAt', limit: 1, depth: 0, overrideAccess: true })
  const draft = prepared.docs[0] as { id: string; sender: string; recipient: string; subject: string; body: string; threadID?: string } | undefined
  return Response.json({ senders: verified ? [{ address, label: String(mailbox.name) }] : [], threads, preparedDraft: draft ? { id: draft.id, sender: draft.sender, recipient: draft.recipient, subject: draft.subject, body: draft.body, threadID: draft.threadID } : null, canAuthorize: user.roles?.includes('owner') === true }, { headers: noStore })
}
async function POSTHandler(request: Request, context: { params: Promise<{ target: string; id: string }> }) {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  if (!configured || request.headers.get('origin') !== new URL(configured).origin) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  const { target, id } = await context.params
  if (target !== 'lead' && target !== 'application') return Response.json({ error: 'Unknown mail target.' }, { status: 404, headers: noStore })
  const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); const user = auth.user as { id: string; roles?: string[] } | null
  if (!user || !hasRole(user as never, target === 'lead' ? ['owner', 'sales'] : ['owner', 'hiring'])) return Response.json({ error: 'Authentication required.' }, { status: 403, headers: noStore })
  let body: Record<string, unknown>; try { body = await request.json() as Record<string, unknown> } catch { return Response.json({ error: 'Send a valid reply request.' }, { status: 400, headers: noStore }) }
  const token = readCookie(request.headers, cookieName(SESSION_COOKIE)); const actor = { id: user.id, sessionToken: token }
  try {
    if (body.action === 'prepare') return Response.json({ draft: await prepareReply(payload, target, id, user.id, body as { sender: unknown; subject: unknown; body: unknown; threadID?: unknown }) }, { status: 201, headers: noStore })
    if (typeof body.grantID !== 'string') throw new Error('invalid_reply')
    const draftID = body.action === 'authorize' ? body.grantID : (await payload.findByID({ collection: 'mail-authorizations', id: body.grantID, depth: 0, overrideAccess: true }) as { draft: string | { id: string } }).draft
    const resolvedDraftID = typeof draftID === 'string' ? draftID : draftID.id
    const draft = await payload.findByID({ collection: 'mail-drafts', id: resolvedDraftID, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const relation = target === 'lead' ? draft.lead : draft.application; const relationID = typeof relation === 'string' ? relation : (relation as { id?: string } | null)?.id
    if (relationID !== id) throw new Error('invalid_reply')
    if (body.action === 'authorize') return Response.json({ authorization: await authorizeReply(payload, actor, resolvedDraftID) }, { headers: noStore })
    if (body.action === 'cancel') return Response.json({ authorization: await cancelReply(payload, actor, body.grantID) }, { headers: noStore })
    if (body.action === 'send') return Response.json({ delivery: await sendReply(payload, actor, body.grantID) }, { headers: noStore })
    throw new Error('invalid_reply')
  } catch (error) { const backpressure = sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, noStore); if (backpressure) return backpressure; const code = error instanceof Error ? error.message : ''; return Response.json({ error: code === 'owner_authorization_required' ? 'A freshly authenticated Owner must confirm this exact reply.' : code === 'authorization_not_usable' ? 'This confirmation is expired, changed, cancelled, or already used.' : 'The reply could not be processed.' }, { status: code === 'authorization_not_usable' ? 409 : 422, headers: noStore }) }
}

export const GET = sqliteAuthenticationBoundary(GETHandler)
export const POST = sqliteAuthenticationBoundary(POSTHandler)
