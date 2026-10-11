import { afterAll, beforeAll, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { generateKeyPair, SignJWT, exportJWK, importJWK } from 'jose'
import { getPayload } from 'payload'

const directory = mkdtempSync(join(tmpdir(), 'mailbox-notifications-'))
Object.assign(process.env, { DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`, PAYLOAD_SECRET: 'mailbox-notifications-test-secret', PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.example.test', INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'), MAILBOX_MICROSOFT_CLIENT_ID: 'client', MAILBOX_MICROSOFT_CLIENT_SECRET: 'secret', MAILBOX_GOOGLE_CLIENT_ID: 'google-client', MAILBOX_GOOGLE_CLIENT_SECRET: 'google-secret', MAILBOX_GOOGLE_PUBSUB_TOPIC: 'projects/test/topics/mail' })
const { default: config } = await import('../payload.config.js')
const { startMailboxOAuth, completeMailboxOAuth } = await import('../src/mailbox-oauth.js')
const { renewMailboxNotifications, revokeMailboxNotifications, receiveMicrosoftNotification, receiveGoogleNotification, googleJWTVerifier, notificationCredentialRevision } = await import('../src/mailbox-notifications.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) }, 120_000)
afterAll(async () => { await payload.destroy(); rmSync(directory, { recursive: true, force: true }) })

async function mailbox(provider: 'microsoft' | 'google', suffix: string) {
  const owner = await payload.create({ collection: 'users', data: { email: `notification-${suffix}@example.test`, name: suffix, roles: ['owner'] }, overrideAccess: true })
  const state = new URL(await startMailboxOAuth(payload, provider, owner.id, `notification-${suffix}`)).searchParams.get('state')!
  return completeMailboxOAuth(payload, provider, state, 'code', owner.id, `notification-${suffix}`, async url => {
    if (url.includes('/token')) return Response.json({ access_token: 'setup', refresh_token: `refresh-${suffix}` })
    if (provider === 'google' && url.endsWith('/profile')) return Response.json({ emailAddress: `${suffix}@example.test`, historyId: '100' })
    if (provider === 'google') return Response.json({ sendAs: [{ sendAsEmail: `${suffix}@example.test`, verificationStatus: 'accepted' }] })
    return Response.json({ mail: `${suffix}@example.test` })
  }) as any
}
const graph = (id = 'sub') => async (_url: string, init: RequestInit) => Response.json({ id, resource: '/me/messages', expirationDateTime: new Date(Date.now() + 45 * 60_000).toISOString() })
const notification = async (id: string) => (await payload.find({ collection: 'mailbox-notifications' as never, where: { mailbox: { equals: id } }, limit: 1, overrideAccess: true }) as any).docs[0]

test('Graph create persists real notification URL, resource, and client state hash', async () => {
  const box = await mailbox('microsoft', 'create')
  let body: any; await renewMailboxNotifications(payload, box.id, 'token', async (_url, init) => { body = JSON.parse(String(init.body)); return Response.json({ id: 'create-sub', resource: '/me/messages', expirationDateTime: new Date(Date.now() + 45 * 60_000).toISOString() }) })
  const row = await notification(box.id)
  expect(body.notificationUrl).toBe('https://cms.example.test/api/email-workspace/notifications/microsoft'); expect(body.resource).toBe('/me/messages'); expect(row.clientStateHash).toMatch(/^[a-f0-9]{64}$/)
})

test('active subscriptions reuse without a provider request', async () => {
  const box = await mailbox('microsoft', 'reuse'); await renewMailboxNotifications(payload, box.id, 'token', graph())
  await renewMailboxNotifications(payload, box.id, 'token', async () => { throw new Error('network must not run') })
})

test('near expiry PATCH preserves the durable Graph client state hash', async () => {
  const box = await mailbox('microsoft', 'patch'); await renewMailboxNotifications(payload, box.id, 'token', graph('patch-sub'))
  const before = await notification(box.id); await (payload as any).update({ collection: 'mailbox-notifications', id: before.id, data: { expiresAt: new Date(Date.now() + 1_000).toISOString() }, overrideAccess: true, context: { mailboxInternal: true } })
  let method = ''; await renewMailboxNotifications(payload, box.id, 'token', async (_url, init) => { method = String(init.method); return Response.json({ id: 'patch-sub', resource: '/me/messages', expirationDateTime: new Date(Date.now() + 45 * 60_000).toISOString() }) })
  expect(method).toBe('PATCH'); expect((await notification(box.id)).clientStateHash).toBe(before.clientStateHash)
})

test('first provider failure creates durable retry backoff', async () => {
  const box = await mailbox('microsoft', 'backoff'); await expect(renewMailboxNotifications(payload, box.id, 'token', async () => new Response('no', { status: 500 }))).rejects.toThrow()
  const row = await notification(box.id); expect(row.status).toBe('failed'); expect(row.renewFailureCount).toBe(1); expect(Date.parse(row.nextRenewAttemptAt)).toBeGreaterThan(Date.now())
})

test('a configuration revision during create does not reactivate the old binding and deletes Graph state', async () => {
  const box = await mailbox('microsoft', 'race'); const calls: string[] = []
  await expect(renewMailboxNotifications(payload, box.id, 'token', async (url, init) => { calls.push(String(init.method)); if (init.method === 'POST') await (payload as any).update({ collection: 'mailbox-configurations', id: box.id, data: { credentialRevision: 'rotated' }, overrideAccess: true, context: { mailboxInternal: true } }); return Response.json({ id: 'race-sub', resource: '/me/messages', expirationDateTime: new Date(Date.now() + 45 * 60_000).toISOString() }) })).rejects.toThrow()
  expect(calls).toContain('DELETE'); expect((await notification(box.id)).status).not.toBe('active')
})

test('local revoke wins even when remote deletion fails', async () => {
  const box = await mailbox('microsoft', 'revoke'); await renewMailboxNotifications(payload, box.id, 'token', graph('revoke-sub'))
  await revokeMailboxNotifications(payload, box.id, 'token', async () => { throw new Error('remote unavailable') })
  const row = await notification(box.id); expect(row.status).toBe('revoked'); expect(row.subscriptionID).toBeNull()
})

test('only a valid, active Graph callback wakes polling', async () => {
  const box = await mailbox('microsoft', 'callback'); let state = ''; await renewMailboxNotifications(payload, box.id, 'token', async (_url, init) => { state = JSON.parse(String(init.body)).clientState; return Response.json({ id: 'callback-sub', resource: '/me/messages', expirationDateTime: new Date(Date.now() + 45 * 60_000).toISOString() }) })
  const row = await notification(box.id); const request = (clientState: string) => new Request('https://cms.example.test/api/email-workspace/notifications/microsoft', { method: 'POST', body: JSON.stringify({ value: [{ subscriptionId: row.subscriptionID, clientState, id: 'wake' }] }) })
  expect((await receiveMicrosoftNotification(payload, request(state))).status).toBe(202); expect((await receiveMicrosoftNotification(payload, request('wrong'))).status).toBe(400)
  await (payload as any).update({ collection: 'mailbox-notifications', id: row.id, data: { status: 'revoked' }, overrideAccess: true, context: { mailboxInternal: true } }); expect((await receiveMicrosoftNotification(payload, request(state))).status).toBe(400)
})

test('signed Google watch callbacks do not trust historyId or advance inbound cursor', async () => {
  const box = await mailbox('google', 'google-watch'); const original = JSON.stringify({ historyID: '100' }); await (payload as any).update({ collection: 'mailbox-configurations', id: box.id, data: { inboundCursor: original }, overrideAccess: true, context: { mailboxInternal: true } })
  await renewMailboxNotifications(payload, box.id, 'token', async () => Response.json({ historyId: '101', expiration: String(Date.now() + 3_600_000) }))
  const { privateKey, publicKey } = await generateKeyPair('RS256'); const key = await importJWK(await exportJWK(publicKey), 'RS256'); process.env.MAILBOX_GOOGLE_PUBSUB_AUDIENCE = 'aud'; process.env.MAILBOX_GOOGLE_PUBSUB_SERVICE_ACCOUNT = 'push@example.test'
  const token = await new SignJWT({ email: 'push@example.test', email_verified: true }).setProtectedHeader({ alg: 'RS256' }).setIssuer('https://accounts.google.com').setAudience('aud').setIssuedAt().setExpirationTime('5m').sign(privateKey)
  const request = new Request('https://cms.example.test', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ message: { messageId: 'google-wake', data: Buffer.from(JSON.stringify({ emailAddress: box.primaryAddress, historyId: 'attacker' })).toString('base64') } }) })
  expect((await receiveGoogleNotification(payload, request, googleJWTVerifier(async () => key))).status).toBe(204); expect((await payload.findByID({ collection: 'mailbox-configurations', id: box.id, overrideAccess: true }) as any).inboundCursor).toBe(original)
})
