import { getPayload } from 'payload'
import config from '../../../payload.config'
import { freshStaff, hasRole } from '../../../src/access'
import { withPayloadTransaction } from '../../../src/auth-transaction'
import { serverSessionStrategy } from '../../../src/identity'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../src/sqlite'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }
const maxBodyBytes = 1024
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: noStore })
function sameOrigin(request: Request) { const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; return Boolean(configured && request.headers.get('origin') === new URL(configured).origin) }
async function actor(request: Request) { const payload = await getPayload({ config }); const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); return { payload, user: authenticated.user as { id?: string; roles?: string[] } | null } }
async function boundedBody(request: Request): Promise<{ hidePhone: boolean }> {
  const reader = request.body?.getReader(); if (!reader) throw new Error('invalid')
  const chunks: Uint8Array[] = []; let length = 0
  try { while (true) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > maxBodyBytes) throw new RangeError('large'); chunks.push(next.value) } } finally { await reader.cancel().catch(() => undefined) }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof (value as Record<string, unknown>).hidePhone !== 'boolean') throw new Error('invalid')
  return value as { hidePhone: boolean }
}
async function setting(payload: Awaited<ReturnType<typeof getPayload>>) { const result = await payload.find({ collection: 'mcp-privacy-settings', where: { key: { equals: 'active' } }, limit: 1, depth: 0, overrideAccess: true }); return result.docs[0] as { id: string; hidePhone?: boolean } | undefined }
export async function GET(request: Request) { const { payload, user } = await actor(request); if (!hasRole(user as never, ['owner'])) return response({ error: 'Owner access required.' }, 403); return response({ hidePhone: (await setting(payload))?.hidePhone !== false }) }
export async function PUT(request: Request) {
  if (!sameOrigin(request)) return response({ error: 'CSRF origin check failed.' }, 403)
  try {
    const { payload, user } = await actor(request)
    if (!user?.id || !(await freshStaff(['owner'])({ req: { payload, user, headers: request.headers } as never }))) return response({ error: 'Fresh Owner authentication is required.' }, 403)
    const body = await boundedBody(request)
    await withPayloadTransaction(payload, async (req) => { const current = await setting(payload); if (current) await payload.update({ collection: 'mcp-privacy-settings', id: current.id, data: { hidePhone: body.hidePhone }, overrideAccess: true, req }); else await payload.create({ collection: 'mcp-privacy-settings', data: { key: 'active', hidePhone: body.hidePhone }, overrideAccess: true, req }); await payload.create({ collection: 'audit-events', data: { event: 'mcp_privacy.updated', user: user.id, actor: user.id, detail: { hidePhone: body.hidePhone } }, overrideAccess: true, req }) })
    return response(body)
  } catch (error) { return sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, noStore) ?? response({ error: error instanceof RangeError ? 'MCP privacy request is too large.' : 'MCP privacy settings are invalid.' }, error instanceof RangeError ? 413 : 400) }
}
