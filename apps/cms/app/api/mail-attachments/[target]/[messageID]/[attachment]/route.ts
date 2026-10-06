import { getPayload } from 'payload'
import config from '../../../../../../payload.config'
import { hasRole } from '../../../../../../src/access'
import { serverSessionStrategy } from '../../../../../../src/identity'
import { downloadMatchedMailAttachment } from '../../../../../../src/mail-attachments'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }

export async function GET(request: Request, context: { params: Promise<{ target: string; messageID: string; attachment: string }> }) {
  const { target, messageID, attachment } = await context.params
  if ((target !== 'lead' && target !== 'application') || !/^[0-9a-f-]{36}$/i.test(messageID) || !/^(?:0|[1-9][0-9]?)$/.test(attachment)) return Response.json({ error: 'Not found.' }, { status: 404, headers })
  const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); const user = auth.user as { roles?: string[] } | null
  if (!user || !hasRole(user as never, target === 'lead' ? ['owner', 'sales'] : ['owner', 'hiring'])) return Response.json({ error: 'Authentication required.' }, { status: 403, headers })
  try {
    const message = await payload.findByID({ collection: 'mail-thread-messages', id: messageID, depth: 0, overrideAccess: false, user: user as never }) as unknown as Record<string, unknown>
    const relation = message[target]
    const targetID = typeof relation === 'string' ? relation : (relation as { id?: string } | undefined)?.id
    if (!targetID) return Response.json({ error: 'Not found.' }, { status: 404, headers })
    const file = await downloadMatchedMailAttachment(payload, { target, targetID, messageID, attachment: Number(attachment) })
    return new Response(file.data, { headers: { ...headers, 'Content-Type': file.contentType, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}` } })
  } catch { return Response.json({ error: 'Attachment is unavailable.' }, { status: 404, headers }) }
}
