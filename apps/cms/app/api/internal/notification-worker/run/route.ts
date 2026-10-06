import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { createNotificationWorkerRunHandler } from '../../../../../src/notification-worker'
import { dispatchOneNotification } from '../../../../../src/notification-dispatch'
import { enqueueDueFollowUps } from '../../../../../src/follow-up-notifications'
import { monitorIntegrationHealth } from '../../../../../src/integration-health-monitor'

export const dynamic = 'force-dynamic'
export async function runNotificationCycle(payload: any, dependencies = { monitor: monitorIntegrationHealth, followUps: enqueueDueFollowUps, dispatch: dispatchOneNotification }) {
  try { await dependencies.monitor(payload) } catch { /* a health probe must never block urgent notification delivery */ }
  try { await dependencies.followUps(payload) } catch { /* scheduled follow-ups must never block urgent notification delivery */ }
  return dependencies.dispatch(payload)
}
const handler = createNotificationWorkerRunHandler({ payload: () => getPayload({ config }), run: runNotificationCycle })
/** Internal-only: it accepts no recipient, content, provider, or result input. */
export async function POST(request: Request): Promise<Response> { return handler(request) }
