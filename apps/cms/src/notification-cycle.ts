import { dispatchOneNotification } from './notification-dispatch'
import { enqueueDueFollowUps } from './follow-up-notifications'
import { monitorIntegrationHealth } from './integration-health-monitor'

export async function runNotificationCycle(payload: any, dependencies = { monitor: monitorIntegrationHealth, followUps: enqueueDueFollowUps, dispatch: dispatchOneNotification }) {
  try { await dependencies.monitor(payload) } catch { /* a health probe must never block urgent notification delivery */ }
  try { await dependencies.followUps(payload) } catch { /* scheduled follow-ups must never block urgent notification delivery */ }
  return dependencies.dispatch(payload)
}
