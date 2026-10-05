import { getPayload } from 'payload'
import config from '../../../payload.config'
import { freshStaff, hasRole } from '../../../src/access'
import { mailboxAreas, mailboxWorkspace, configureSMTPMailbox, sendAuthorizedMailboxTest, setMailboxArea, testSMTPMailbox, type MailboxArea, type MailboxSecurity } from '../../../src/mailboxes'
import { serverSessionStrategy } from '../../../src/identity'

export const dynamic = 'force-dynamic'
const MAX_BYTES = 32 * 1024
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
const sameOrigin = (request: Request) => { const origin = request.headers.get('origin'); const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; return Boolean(origin && configured && origin === new URL(configured).origin) }
async function body(request: Request) { const bytes = new Uint8Array(await request.arrayBuffer()); if (bytes.byteLength > MAX_BYTES) throw new Error('too_large'); const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes)); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid'); return parsed as Record<string, unknown> }
async function owner(request: Request) { const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); return { payload, user: auth.user as { id: string; roles?: string[] } | null } }

export async function GET(request: Request) {
  const { payload, user } = await owner(request); if (!hasRole(user as never, ['owner'])) return json({ error: 'Owner access required.' }, 403)
  return json(await mailboxWorkspace(payload))
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'CSRF origin check failed.' }, 403)
  try {
    const { payload, user } = await owner(request); if (!user || !(await freshStaff(['owner'])({ req: { payload, user, headers: request.headers } as never }))) return json({ error: 'Fresh Owner authentication is required.' }, 403)
    const input = await body(request)
    if (input.action === 'configure-smtp') {
      const keys = ['action', 'id', 'name', 'primaryAddress', 'aliases', 'host', 'port', 'security', 'username', 'password']; if (!Object.keys(input).every((key) => keys.includes(key)) || (input.id !== undefined && typeof input.id !== 'string') || typeof input.name !== 'string' || typeof input.primaryAddress !== 'string' || !Array.isArray(input.aliases) || !input.aliases.every((alias) => typeof alias === 'string') || typeof input.host !== 'string' || typeof input.port !== 'number' || !['starttls', 'tls'].includes(String(input.security)) || typeof input.username !== 'string' || (input.password !== undefined && typeof input.password !== 'string')) throw new Error('invalid')
      await configureSMTPMailbox(payload, { id: input.id, name: input.name, primaryAddress: input.primaryAddress, aliases: input.aliases, host: input.host, port: input.port, security: input.security as MailboxSecurity, username: input.username, password: input.password }, user.id)
    } else if (input.action === 'test-connection' && Object.keys(input).sort().join(',') === 'action,id' && typeof input.id === 'string') await testSMTPMailbox(payload, input.id, user.id)
    else if (input.action === 'map-area' && Object.keys(input).sort().join(',') === 'action,area,mailbox,senderAddress' && typeof input.area === 'string' && mailboxAreas.includes(input.area as MailboxArea) && typeof input.mailbox === 'string' && typeof input.senderAddress === 'string') await setMailboxArea(payload, { area: input.area as MailboxArea, mailbox: input.mailbox, senderAddress: input.senderAddress }, user.id)
    else if (input.action === 'send-test' && Object.keys(input).sort().join(',') === 'action,body,confirmed,mailbox,recipientAddress,requestKey,senderAddress,subject' && typeof input.requestKey === 'string' && typeof input.mailbox === 'string' && typeof input.senderAddress === 'string' && typeof input.recipientAddress === 'string' && typeof input.subject === 'string' && typeof input.body === 'string' && input.confirmed === true) await sendAuthorizedMailboxTest(payload, { requestKey: input.requestKey, mailbox: input.mailbox, senderAddress: input.senderAddress, recipientAddress: input.recipientAddress, subject: input.subject, body: input.body, confirmed: true }, user.id)
    else throw new Error('invalid')
    return json(await mailboxWorkspace(payload))
  } catch (error) {
    if (error instanceof Error && error.message === 'too_large') return json({ error: 'Request is too large.' }, 413)
    return json({ error: error instanceof Error && /confirmation|request key|not configured|must be tested|could not be delivered/i.test(error.message) ? error.message : 'Email workspace request could not be completed.' }, 400)
  }
}
