import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPayload } from 'payload'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'
const directory = mkdtempSync(join(tmpdir(), 'notification-user-preferences-'))
Object.assign(process.env, { DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`, PAYLOAD_SECRET: 'notification-user-preferences-secret', PAYLOAD_PUBLIC_SERVER_URL: 'http://cms.test' })
const { default: config } = await import('../payload.config.js'); const route = await import('../app/api/notification-user-preferences/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload.destroy(); rmSync(directory, { recursive: true, force: true }) })
async function cookie(email: string) { const user = await payload.create({ collection: 'users', data: { email, name: email, roles: ['sales'] }, overrideAccess: true }); const token = newOpaqueToken(); const now = new Date().toISOString(); await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true }); return `${cookieName(SESSION_COOKIE)}=${token}` }
test('a signed-in user can mute only their own non-urgent kinds', async () => {
  const first = await cookie('first-mute@example.test'); const second = await cookie('second-mute@example.test')
  const put = (value: unknown, valueCookie = first, origin = 'http://cms.test') => route.PUT(new Request('http://cms.test/api/notification-user-preferences', { method: 'PUT', headers: { cookie: valueCookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(value) }))
  expect((await put({ mutedKinds: ['active-incident-lead'] })).status).toBe(400)
  expect((await put({ mutedKinds: ['new-lead'] }, first, 'https://attacker.test')).status).toBe(403)
  expect((await put({ mutedKinds: ['new-lead'] })).status).toBe(200)
  await expect((await route.GET(new Request('http://cms.test/api/notification-user-preferences', { headers: { cookie: first } }))).json()).resolves.toEqual({ mutedKinds: ['new-lead'] })
  await expect((await route.GET(new Request('http://cms.test/api/notification-user-preferences', { headers: { cookie: second } }))).json()).resolves.toEqual({ mutedKinds: [] })
})
