import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPayload } from 'payload'
import { cookieName, hashOpaqueToken, SESSION_COOKIE } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'email-workspace-route-'))
Object.assign(process.env, { DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`, PAYLOAD_SECRET: 'email-workspace-route-secret', PAYLOAD_PUBLIC_SERVER_URL: 'http://cms.example.test', INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64url') })
const { default: config } = await import('../payload.config.js'); const route = await import('../app/api/email-workspace/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload.destroy(); rmSync(directory, { recursive: true, force: true }); delete process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY })
async function identity(role: 'owner' | 'editor', name: string, stale = false) { const user = await payload.create({ collection: 'users', data: { email: `${name}@example.test`, name, roles: [role] }, overrideAccess: true }); const token = `session-${name}`; await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: new Date(Date.now() - (stale ? 20 : 1) * 60_000).toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true }); return { user, cookie: `${cookieName(SESSION_COOKIE)}=${token}` } }
const request = (cookie: string, value: unknown, origin = 'http://cms.example.test') => route.POST(new Request('http://cms.example.test/api/email-workspace', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(value) }))

test('mailbox configuration is Owner-only, fresh, same-origin, bounded, and secret-free', async () => {
  const owner = await identity('owner', 'mail-route-owner'); const editor = await identity('editor', 'mail-route-editor'); const stale = await identity('owner', 'mail-route-stale', true)
  expect((await route.GET(new Request('http://cms.example.test/api/email-workspace', { headers: { cookie: editor.cookie } }))).status).toBe(403)
  expect((await request(owner.cookie, { action: 'configure-smtp' }, 'http://wrong.example.test')).status).toBe(403)
  expect((await request(stale.cookie, { action: 'configure-smtp' })).status).toBe(403)
  expect((await request(owner.cookie, { action: 'configure-smtp', name: 'x'.repeat(33_000) })).status).toBe(413)
  const configured = await request(owner.cookie, { action: 'configure-smtp', name: 'Primary mailbox', primaryAddress: 'hello@example.test', aliases: ['careers@example.test'], host: 'smtp.example.test', port: 587, security: 'starttls', username: 'smtp-user', password: 'route-secret-password' }); expect(configured.status).toBe(200)
  const body = await configured.json(); expect(body.mailboxes).toMatchObject([{ name: 'Primary mailbox', primaryAddress: 'hello@example.test', aliases: ['careers@example.test'], credentialConfigured: true }]); expect(JSON.stringify(body)).not.toContain('route-secret-password')
  const stored = (await payload.find({ collection: 'mailbox-configurations', overrideAccess: true })).docs[0]!; expect(stored.encryptedCredential).not.toContain('route-secret-password')
  expect(JSON.stringify(await payload.find({ collection: 'audit-events', overrideAccess: true }))).not.toContain('route-secret-password')
})
