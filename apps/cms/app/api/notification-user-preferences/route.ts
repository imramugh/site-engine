import { sqliteAuthenticationBoundary } from '../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../payload.config'
import { serverSessionStrategy } from '../../../src/identity'
import { notificationEventKinds } from '../../../src/notification-settings'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../src/sqlite'
export const dynamic = 'force-dynamic'
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
async function actor(request: Request) { const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); return { payload, user: auth.user as { id?: string } | null } }
function origin(request: Request) { const expected = process.env.PAYLOAD_PUBLIC_SERVER_URL; return Boolean(expected && request.headers.get('origin') === new URL(expected).origin) }
async function GETHandler(request: Request) {
  try {
    const { payload, user } = await actor(request); if (!user?.id) return response({ error: 'Unauthorized.' }, 403)
    const found = await (payload as any).find({ collection: 'notification-user-preferences', where: { user: { equals: user.id } }, limit: 1, depth: 0, overrideAccess: true })
    return response({ mutedKinds: found.docs[0]?.mutedKinds ?? [] })
  } catch (error) { return sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, { 'Cache-Control': 'no-store' }) ?? response({ error: 'Preferences could not be loaded.' }, 400) }
}
async function PUTHandler(request: Request) {
  if (!origin(request)) return response({ error: 'CSRF origin check failed.' }, 403)
  try {
    const { payload, user } = await actor(request); if (!user?.id) return response({ error: 'Unauthorized.' }, 403)
    let body: unknown; try { body = await request.json() } catch { return response({ error: 'Invalid preferences.' }, 400) }
    const kinds = (body as { mutedKinds?: unknown })?.mutedKinds
    if (!Array.isArray(kinds) || kinds.length > notificationEventKinds.length || [...new Set(kinds)].length !== kinds.length || kinds.some((kind) => typeof kind !== 'string' || !notificationEventKinds.includes(kind as never) || kind === 'active-incident-lead')) return response({ error: 'Invalid preferences.' }, 400)
    const existing = await (payload as any).find({ collection: 'notification-user-preferences', where: { user: { equals: user.id } }, limit: 1, depth: 0, overrideAccess: true }); const saved = existing.docs[0] ? await (payload as any).update({ collection: 'notification-user-preferences', id: existing.docs[0].id, data: { mutedKinds: kinds }, overrideAccess: true }) : await (payload as any).create({ collection: 'notification-user-preferences', data: { user: user.id, mutedKinds: kinds }, overrideAccess: true }); return response({ mutedKinds: saved.mutedKinds })
  } catch (error) { return sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, { 'Cache-Control': 'no-store' }) ?? response({ error: 'Preferences could not be saved.' }, 400) }
}

export const GET = sqliteAuthenticationBoundary(GETHandler)
export const PUT = sqliteAuthenticationBoundary(PUTHandler)
