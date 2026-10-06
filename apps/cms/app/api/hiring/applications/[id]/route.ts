import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { hasRole } from '../../../../../src/access'
import { serverSessionStrategy } from '../../../../../src/identity'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../../../src/sqlite'

export const dynamic = 'force-dynamic'
const stages = new Set(['new', 'reviewing', 'interview', 'offer', 'hired', 'declined', 'closed'])

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  if (!configured || request.headers.get('origin') !== new URL(configured).origin) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403 })
  const payload = await getPayload({ config }); const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); const user = authenticated.user as { id: string; roles?: ('owner' | 'hiring')[]; disabled?: boolean } | null
  if (!user || !hasRole(user, ['owner', 'hiring'])) return Response.json({ error: 'Authentication required.' }, { status: 403 })
  let status: unknown
  try { status = (await request.json() as { status?: unknown }).status } catch { return Response.json({ error: 'Send a valid stage.' }, { status: 400 }) }
  if (typeof status !== 'string' || !stages.has(status)) return Response.json({ error: 'Send a valid stage.' }, { status: 400 })
  try { const { id } = await context.params; const current = await payload.findByID({ collection: 'applications', id, user, overrideAccess: false }) as { status: string }; const application = await payload.update({ collection: 'applications', id, data: { status: status as 'new' | 'reviewing' | 'interview' | 'offer' | 'hired' | 'declined' | 'closed' }, user, overrideAccess: false }) as { id: string; status: string }; if (current.status !== application.status) await payload.create({ collection: 'audit-events', data: { event: 'application.stage_changed', user: String(user.id), actor: String(user.id), detail: { applicationID: id, from: current.status, to: application.status } }, overrideAccess: true }); return Response.json({ id: application.id, status: application.status }) } catch (error) { return sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }) ?? Response.json({ error: 'Application not found.' }, { status: 404 }) }
}
