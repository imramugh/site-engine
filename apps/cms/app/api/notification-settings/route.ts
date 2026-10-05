import { getPayload } from 'payload'
import config from '../../../payload.config'
import { freshStaff, hasRole } from '../../../src/access'
import { withPayloadTransaction } from '../../../src/auth-transaction'
import { defaultNotificationPreferences, parseNotificationPreferences, readNotificationPreferences, saveNotificationPreferences } from '../../../src/notification-settings'
import { serverSessionStrategy } from '../../../src/identity'

export const dynamic = 'force-dynamic'
const privateJSON = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const sameOrigin = (request: Request) => { const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; const origin = request.headers.get('origin'); return Boolean(configured && origin && origin === new URL(configured).origin) }
async function boundedJSON(request: Request) {
  if (!request.body) throw new Error('invalid_body')
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 16 * 1024) throw new RangeError(); chunks.push(next.value) } } finally { await reader.cancel().catch(() => undefined) }
  const value: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_body')
  return value as Record<string, unknown>
}
async function actor(request: Request) { const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); return { payload, user: auth.user as { id?: string; roles?: string[] } | null } }

export async function GET(request: Request) {
  const { payload, user } = await actor(request)
  if (!hasRole(user as never, ['owner'])) return privateJSON({ error: 'Owner access required.' }, 403)
  const events = await readNotificationPreferences(payload)
  return privateJSON({ events, defaults: defaultNotificationPreferences, capabilities: { emailDelivery: false, smsDelivery: false, producers: { 'new-lead': true, 'active-incident-lead': true, 'new-job-application': true, 'change-set-submitted': true, 'follow-ups-due': false, 'publish-or-integration-failed': true } } })
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return privateJSON({ error: 'CSRF origin check failed.' }, 403)
  try {
    const { payload, user } = await actor(request)
    if (!user?.id || !(await freshStaff(['owner'])({ req: { payload, user, headers: request.headers } as never }))) return privateJSON({ error: 'Fresh Owner authentication is required.' }, 403)
    const body = await boundedJSON(request); const events = parseNotificationPreferences(body.events)
    if (!events) return privateJSON({ error: 'Notification preferences are invalid.' }, 400)
    await withPayloadTransaction(payload, (req) => saveNotificationPreferences(payload, req, events, user.id!))
    return privateJSON({ events })
  } catch (error) { return privateJSON({ error: error instanceof RangeError ? 'Notification settings request is too large.' : 'Notification preferences could not be saved.' }, error instanceof RangeError ? 413 : 400) }
}
