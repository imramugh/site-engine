import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'
import { defaultNotificationPreferences } from '../src/notification-settings'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-notification-access-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'notification-access-test-secret-long-enough'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
const { default: config } = await import('../payload.config.js')
const notificationRoute = await import('../app/api/notification-settings/route.js')
const contactRoute = await import('../app/api/urgent-contacts/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })
async function session(userID: string, fresh = true) { const token = newOpaqueToken(); const now = new Date(); await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: userID, authenticatedAt: new Date(now.getTime() - (fresh ? 0 : 20 * 60_000)).toISOString(), lastSeenAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() }, overrideAccess: true }); return `${cookieName(SESSION_COOKIE)}=${token}` }

describe('notification and urgent-contact route privacy', () => {
  it('denies every non-Owner role and direct Payload reads, including assistant-visible access', async () => {
    for (const role of ['editor', 'approver', 'sales', 'hiring'] as const) {
      const user = await payload.create({ collection: 'users', data: { name: role, email: `${role}-notification@example.test`, roles: [role] }, overrideAccess: true }); const cookie = await session(user.id)
      expect((await notificationRoute.GET(new Request('http://cms.test/api/notification-settings', { headers: { cookie } }))).status).toBe(403)
      expect((await contactRoute.GET(new Request('http://cms.test/api/urgent-contacts', { headers: { cookie } }))).status).toBe(403)
      await expect(payload.find({ collection: 'urgent-contacts', user, overrideAccess: false })).rejects.toThrow('not allowed')
      await expect(payload.find({ collection: 'notification-preferences', user, overrideAccess: false })).rejects.toThrow('not allowed')
    }
  })

  it('requires same-origin fresh Owner intent and enforces bounded validated bodies', async () => {
    const owner = await payload.create({ collection: 'users', data: { name: 'Owner', email: 'owner-notification@example.test', roles: ['owner'] }, overrideAccess: true }); const fresh = await session(owner.id); const stale = await session(owner.id, false)
    const post = (route: typeof notificationRoute.POST, cookie: string, origin: string, body: unknown) => route(new Request('http://cms.test/api/notification-settings', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    expect((await post(notificationRoute.POST, fresh, 'https://attacker.example', { events: defaultNotificationPreferences })).status).toBe(403)
    expect((await post(notificationRoute.POST, stale, 'http://cms.test', { events: defaultNotificationPreferences })).status).toBe(403)
    expect((await post(notificationRoute.POST, fresh, 'http://cms.test', { events: [] })).status).toBe(400)
    expect((await post(notificationRoute.POST, fresh, 'http://cms.test', { events: defaultNotificationPreferences, padding: 'x'.repeat(17 * 1024) })).status).toBe(413)
    expect((await post(notificationRoute.POST, fresh, 'http://cms.test', { events: defaultNotificationPreferences })).status).toBe(200)
    const contacts = [{ name: 'Primary incident lead', email: 'incident@example.test', mobile: '+1 416 555 0123', enabled: true }]
    expect((await post(contactRoute.POST, fresh, 'http://cms.test', { contacts })).status).toBe(200)
    const response = await contactRoute.GET(new Request('http://cms.test/api/urgent-contacts', { headers: { cookie: fresh } })); expect(response.status).toBe(200); await expect(response.json()).resolves.toMatchObject({ contacts: [{ name: contacts[0]!.name, email: contacts[0]!.email, mobile: contacts[0]!.mobile, enabled: true }] })
  })
})
