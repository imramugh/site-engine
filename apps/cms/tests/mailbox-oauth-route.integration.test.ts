import { createClient } from '@libsql/client'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPayload } from 'payload'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-mailbox-oauth-route-'))
Object.assign(process.env, {
  DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`,
  PAYLOAD_SECRET: 'mailbox-oauth-route-test-secret-long-enough',
  PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.example.test',
  INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64url'),
  MAILBOX_MICROSOFT_CLIENT_ID: 'test-client',
  MAILBOX_MICROSOFT_CLIENT_SECRET: 'test-secret',
})

const { default: config } = await import('../payload.config.js')
const route = await import('../app/api/email-workspace/oauth/[provider]/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => {
  await payload?.destroy()
  rmSync(directory, { recursive: true, force: true })
  for (const key of ['DATABASE_URI', 'PAYLOAD_SECRET', 'PAYLOAD_PUBLIC_SERVER_URL', 'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY', 'MAILBOX_MICROSOFT_CLIENT_ID', 'MAILBOX_MICROSOFT_CLIENT_SECRET']) delete process.env[key]
})

async function ownerCookie() {
  const token = newOpaqueToken()
  const now = new Date().toISOString()
  const user = await payload.create({ collection: 'users', data: { email: `mailbox-owner-${token.slice(0, 8)}@example.test`, name: 'Mailbox owner', roles: ['owner'] }, overrideAccess: true })
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  return `${cookieName(SESSION_COOKIE)}=${token}`
}

const start = (cookie: string) => route.GET(new Request('https://cms.example.test/api/email-workspace/oauth/microsoft', { headers: { cookie } }), { params: Promise.resolve({ provider: 'microsoft' }) })

test('returns safe retryable backpressure when an external writer blocks mailbox OAuth state persistence, then starts after release', async () => {
  const cookie = await ownerCookie()
  const before = await (payload as any).count({ collection: 'mailbox-oauth-transactions', overrideAccess: true })
  const external = createClient({ url: `file:${join(directory, 'cms.sqlite')}` })
  const lock = await external.transaction('write')
  try {
    await lock.execute('UPDATE mailbox_oauth_transactions SET updated_at = updated_at WHERE 0')
    const blocked = await start(cookie)
    expect(blocked.status).toBe(503)
    expect(blocked.headers.get('Retry-After')).toBe('1')
    expect(blocked.headers.get('Cache-Control')).toBe('no-store')
    await expect(blocked.text()).resolves.toBe('Mailbox authorization is temporarily unavailable. Please restart authorization.')
    expect((await (payload as any).count({ collection: 'mailbox-oauth-transactions', overrideAccess: true })).totalDocs).toBe(before.totalDocs)
  } finally {
    await lock.rollback()
    await external.close()
  }
  const retried = await start(cookie)
  expect(retried.status).toBe(302)
  expect(retried.headers.get('location')).toContain('login.microsoftonline.com')
  expect((await (payload as any).count({ collection: 'mailbox-oauth-transactions', overrideAccess: true })).totalDocs).toBe(before.totalDocs + 1)
}, 15_000)
