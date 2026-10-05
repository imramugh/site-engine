import { getPayload } from 'payload'
import config from '../../../payload.config'
import { freshStaff, hasRole } from '../../../src/access'
import { withPayloadTransaction } from '../../../src/auth-transaction'
import { serverSessionStrategy } from '../../../src/identity'

export const dynamic = 'force-dynamic'
type Contact = { id?: string; name: string; email: string; mobile?: string; enabled: boolean }
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const mobilePattern = /^\+?[0-9 ()-]{7,24}$/
const privateJSON = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const sameOrigin = (request: Request) => { const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; const origin = request.headers.get('origin'); return Boolean(configured && origin && origin === new URL(configured).origin) }
async function actor(request: Request) { const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); return { payload, user: auth.user as { id?: string; roles?: string[] } | null } }
async function body(request: Request): Promise<Contact[] | undefined> {
  if (!request.body) return undefined
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 16 * 1024) throw new RangeError(); chunks.push(next.value) } } finally { await reader.cancel().catch(() => undefined) }
  const raw: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); const items = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { contacts?: unknown }).contacts : undefined
  if (!Array.isArray(items) || items.length > 20) return undefined
  const parsed: Contact[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
    const value = item as Record<string, unknown>; const name = typeof value.name === 'string' ? value.name.trim() : ''; const email = typeof value.email === 'string' ? value.email.trim().toLowerCase() : ''; const mobile = typeof value.mobile === 'string' ? value.mobile.trim() : ''
    if (!name || name.length > 120 || !emailPattern.test(email) || email.length > 254 || (mobile && !mobilePattern.test(mobile)) || typeof value.enabled !== 'boolean' || (value.id !== undefined && (typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.id)))) return undefined
    parsed.push({ ...(typeof value.id === 'string' ? { id: value.id } : {}), name, email, ...(mobile ? { mobile } : {}), enabled: value.enabled })
  }
  if (new Set(parsed.map((item) => item.email)).size !== parsed.length) return undefined
  return parsed
}

export async function GET(request: Request) {
  const { payload, user } = await actor(request)
  if (!hasRole(user as never, ['owner'])) return privateJSON({ error: 'Owner access required.' }, 403)
  const result = await payload.find({ collection: 'urgent-contacts', sort: 'name', limit: 20, depth: 0, overrideAccess: true })
  return privateJSON({ contacts: result.docs.map((item) => ({ id: item.id, name: item.name, email: item.email, mobile: item.mobile ?? '', enabled: item.enabled })) })
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return privateJSON({ error: 'CSRF origin check failed.' }, 403)
  try {
    const { payload, user } = await actor(request)
    if (!user?.id || !(await freshStaff(['owner'])({ req: { payload, user, headers: request.headers } as never }))) return privateJSON({ error: 'Fresh Owner authentication is required.' }, 403)
    const contacts = await body(request); if (!contacts) return privateJSON({ error: 'Urgent contacts are invalid.' }, 400)
    await withPayloadTransaction(payload, async (req) => {
      const current = await payload.find({ collection: 'urgent-contacts', limit: 50, pagination: false, depth: 0, overrideAccess: true, req }); const retained = new Set(contacts.flatMap((item) => item.id ? [item.id] : []))
      for (const contact of contacts) contact.id
        ? await payload.update({ collection: 'urgent-contacts', id: contact.id, data: { name: contact.name, email: contact.email, mobile: contact.mobile, enabled: contact.enabled }, overrideAccess: true, req })
        : await payload.create({ collection: 'urgent-contacts', data: contact, overrideAccess: true, req })
      for (const contact of current.docs) if (!retained.has(contact.id)) await payload.delete({ collection: 'urgent-contacts', id: contact.id, overrideAccess: true, req })
      await payload.create({ collection: 'audit-events', data: { event: 'notification.urgent_contacts_updated', user: user.id, actor: user.id, detail: { count: contacts.length, enabled: contacts.filter((item) => item.enabled).length } }, overrideAccess: true, req })
    })
    return privateJSON({ contacts })
  } catch (error) { return privateJSON({ error: error instanceof RangeError ? 'Urgent contacts request is too large.' : 'Urgent contacts could not be saved.' }, error instanceof RangeError ? 413 : 400) }
}
