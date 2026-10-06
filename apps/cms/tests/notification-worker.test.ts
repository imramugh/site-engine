import { describe, expect, it } from 'vitest'
import { createNotificationWorkerRunHandler, notificationWorkerAuthorized } from '../src/notification-worker'
import { runNotificationCycle } from '../src/notification-cycle'

describe('notification worker boundary', () => {
  it('fails closed without a configured matching bearer token', async () => {
    const previous = process.env.NOTIFICATION_WORKER_TOKEN
    delete process.env.NOTIFICATION_WORKER_TOKEN
    expect(notificationWorkerAuthorized(new Request('http://cms.test/api/internal/notification-worker/run'))).toBe(false)
    process.env.NOTIFICATION_WORKER_TOKEN = 'n'.repeat(32)
    const handler = createNotificationWorkerRunHandler({ payload: async () => { throw new Error('must not load') }, run: async () => null })
    expect((await handler(new Request('http://cms.test/api/internal/notification-worker/run', { method: 'POST', headers: { authorization: 'Bearer wrong' } }))).status).toBe(401)
    if (previous === undefined) delete process.env.NOTIFICATION_WORKER_TOKEN; else process.env.NOTIFICATION_WORKER_TOKEN = previous
  })

  it('exposes only a bounded delivery receipt to the token-authenticated caller', async () => {
    const previous = process.env.NOTIFICATION_WORKER_TOKEN; process.env.NOTIFICATION_WORKER_TOKEN = 't'.repeat(32)
    const handler = createNotificationWorkerRunHandler({ payload: async () => ({}), run: async () => ({ id: 'delivery-id', state: 'delivered' }) })
    const response = await handler(new Request('http://cms.test/api/internal/notification-worker/run', { method: 'POST', headers: { authorization: `Bearer ${'t'.repeat(32)}` } }))
    expect(response.status).toBe(200); await expect(response.json()).resolves.toEqual({ delivery: { id: 'delivery-id', state: 'delivered' } })
    if (previous === undefined) delete process.env.NOTIFICATION_WORKER_TOKEN; else process.env.NOTIFICATION_WORKER_TOKEN = previous
  })

  it('continues urgent dispatch when monitor or scheduled follow-up work fails', async () => {
    const calls: string[] = []
    await expect(runNotificationCycle({}, { monitor: async () => { calls.push('monitor'); throw new Error('monitor unavailable') }, followUps: async () => { calls.push('follow-ups'); throw new Error('schedule unavailable') }, dispatch: async () => { calls.push('dispatch'); return { id: 'urgent-receipt', state: 'delivered' } } })).resolves.toEqual({ id: 'urgent-receipt', state: 'delivered' })
    expect(calls).toEqual(['monitor', 'follow-ups', 'dispatch'])
  })
})
