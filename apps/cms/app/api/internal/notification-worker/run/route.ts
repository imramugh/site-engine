import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { createNotificationWorkerRunHandler } from '../../../../../src/notification-worker'
import { dispatchOneNotification } from '../../../../../src/notification-dispatch'
import { enqueueDueFollowUps } from '../../../../../src/follow-up-notifications'
import { monitorIntegrationHealth } from '../../../../../src/integration-health-monitor'

export const dynamic = 'force-dynamic'
const handler = createNotificationWorkerRunHandler({ payload: () => getPayload({ config }), run: async payload => { try { await monitorIntegrationHealth(payload) } catch { /* a health probe must never block urgent notification delivery */ } await enqueueDueFollowUps(payload); return dispatchOneNotification(payload) } })
/** Internal-only: it accepts no recipient, content, provider, or result input. */
export async function POST(request: Request): Promise<Response> { return handler(request) }
