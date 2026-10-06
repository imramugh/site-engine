import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
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

test('returns safe retryable backpressure when an aged authenticated session cannot update last seen, then succeeds after unlock', async () => {
  const value = await cookie('locked-last-seen@example.test')
  const token = value.slice(value.indexOf('=') + 1)
  const session = (await payload.find({ collection: 'auth-sessions', where: { tokenHash: { equals: hashOpaqueToken(token) } }, limit: 1, overrideAccess: true })).docs[0]!
  await payload.update({ collection: 'auth-sessions', id: session.id, data: { lastSeenAt: new Date(Date.now() - 61_000).toISOString() }, overrideAccess: true })
  const external = createClient({ url: `file:${join(directory, 'cms.sqlite')}` })
  const lock = await external.transaction('write')
  try {
    await lock.execute({ sql: 'UPDATE auth_sessions SET updated_at = updated_at WHERE id = ?', args: [session.id] })
    const blocked = await route.PUT(new Request('http://cms.test/api/notification-user-preferences', { method: 'PUT', headers: { cookie: value, origin: 'http://cms.test', 'content-type': 'application/json' }, body: JSON.stringify({ mutedKinds: ['new-lead'] }) }))
    expect(blocked.status).toBe(503); expect(blocked.headers.get('Retry-After')).toBe('1'); expect(await blocked.json()).toEqual({ error: 'Saving is temporarily busy. Please retry.' })
    expect((await payload.find({ collection: 'notification-user-preferences', where: { user: { equals: session.user } }, limit: 1, overrideAccess: true })).docs).toHaveLength(0)
  } finally { await lock.rollback(); external.close() }
  const retried = await route.PUT(new Request('http://cms.test/api/notification-user-preferences', { method: 'PUT', headers: { cookie: value, origin: 'http://cms.test', 'content-type': 'application/json' }, body: JSON.stringify({ mutedKinds: ['new-lead'] }) }))
  expect(retried.status).toBe(200); expect(await retried.json()).toEqual({ mutedKinds: ['new-lead'] })
}, 15_000)
