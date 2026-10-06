import { sqliteAuthenticationBoundary } from '../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../payload.config'
import { freshStaff, hasRole } from '../../../src/access'
import { listAssistantGrants, revokeAssistantGrant } from '../../../src/connected-assistants'
import { serverSessionStrategy } from '../../../src/identity'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../src/sqlite'

export const dynamic = 'force-dynamic'
const roles = ['owner', 'editor', 'approver', 'sales', 'hiring'] as const
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } })
const sameOrigin = (request: Request) => { const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; const origin = request.headers.get('origin'); return Boolean(configured && origin && origin === new URL(configured).origin) }
async function actor(request: Request) { const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); return { payload, user: auth.user as { id: string; roles?: string[]; disabled?: boolean; name?: string; email?: string } | null } }

async function GETHandler(request: Request) {
  try {
    const { payload, user } = await actor(request); if (!hasRole(user as never, [...roles])) return json({ error: 'Staff access required.' }, 403)
    const owner = hasRole(user as never, ['owner']); const grants = await listAssistantGrants(owner ? undefined : user!.id)
    const ids = [...new Set(grants.map((grant) => grant.userId))]
    const people = ids.length ? await payload.find({ collection: 'users', where: { id: { in: ids } }, limit: Math.min(ids.length, 500), depth: 0, overrideAccess: true }) : { docs: [] }
    const byID = new Map(people.docs.map((person) => [String(person.id), { name: person.name, email: person.email }]))
    return json({ scope: owner ? 'all' : 'own', endpoint: process.env.PAYLOAD_PUBLIC_SERVER_URL ? new URL('/mcp', process.env.PAYLOAD_PUBLIC_SERVER_URL).href : null, grants: grants.map(({ userId, clientId: _clientId, ...grant }) => ({ ...grant, person: byID.get(userId) ?? { name: 'Former staff account', email: '' }, own: userId === user!.id })) })
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Connected assistants could not be loaded.' }, 503) }
}

async function POSTHandler(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'CSRF origin check failed.' }, 403)
  try {
    const { payload, user } = await actor(request); if (!hasRole(user as never, [...roles])) return json({ error: 'Staff access required.' }, 403)
    if (!(await freshStaff([...roles])({ req: { payload, user, headers: request.headers } as never }))) return json({ error: 'Fresh authentication is required.' }, 403)
    const bytes = new Uint8Array(await request.arrayBuffer()); if (bytes.byteLength > 4_096) return json({ error: 'Request is too large.' }, 413)
    const body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    if (Object.keys(body).sort().join(',') !== 'action,managementId' || body.action !== 'revoke' || typeof body.managementId !== 'string') return json({ error: 'Invalid assistant request.' }, 400)
    await revokeAssistantGrant(body.managementId, hasRole(user as never, ['owner']) ? undefined : user!.id)
    await payload.create({ collection: 'audit-events', data: { event: 'identity.assistant_revoked', actor: user!.id, detail: { managementId: body.managementId, scope: hasRole(user as never, ['owner']) ? 'owner' : 'own' } }, overrideAccess: true })
    return json({ revoked: true })
  } catch (error) { return sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, { 'Cache-Control': 'private, no-store' }) ?? json({ error: error instanceof Error ? error.message : 'Connected assistant could not be revoked.' }, 400) }
}

export const GET = sqliteAuthenticationBoundary(GETHandler)
export const POST = sqliteAuthenticationBoundary(POSTHandler)
