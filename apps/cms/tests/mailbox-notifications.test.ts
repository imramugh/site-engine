import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPair, SignJWT, exportJWK, importJWK } from 'jose'
import { googleJWTVerifier, notificationCredentialRevision, receiveGoogleNotification, receiveMicrosoftNotification, renewMailboxNotifications } from '../src/mailbox-notifications'
const payload = { find: async () => ({ docs: [] }) } as any
describe('ENG-020 mailbox notification gates', () => {
  it('returns Graph validationToken without reading a notification body', async () => {
    const response = await receiveMicrosoftNotification(payload, new Request('https://cms.test?validationToken=opaque', { method: 'POST', body: 'not-json' }))
    expect(response.status).toBe(200); expect(await response.text()).toBe('opaque')
  })
  it('rejects oversized Graph notification bodies', async () => {
    const response = await receiveMicrosoftNotification(payload, new Request('https://cms.test', { method: 'POST', body: 'x'.repeat(70_000) }))
    expect(response.status).toBe(400)
  })
  it('rejects missing auth before parsing the Pub/Sub body', async () => {
    const response = await receiveGoogleNotification(payload, new Request('https://cms.test', { method: 'POST', body: '{bad' }), async () => { throw new Error('bad') })
    expect(response.status).toBe(400)
  })
  it('rejects a verifier failure without querying a mailbox', async () => {
    let queried = false; const guarded = { find: async () => { queried = true; return { docs: [] } } } as any
    const response = await receiveGoogleNotification(guarded, new Request('https://cms.test', { method: 'POST', headers: { authorization: 'Bearer invalid' }, body: '{}' }), async () => { throw new Error('bad') })
    expect(response.status).toBe(400); expect(queried).toBe(false)
  })
  it('accepts a real RS256 Google JWT only with all required claims', async () => {
    const priorAudience = process.env.MAILBOX_GOOGLE_PUBSUB_AUDIENCE; const priorEmail = process.env.MAILBOX_GOOGLE_PUBSUB_SERVICE_ACCOUNT
    process.env.MAILBOX_GOOGLE_PUBSUB_AUDIENCE = 'https://cms.test/push'; process.env.MAILBOX_GOOGLE_PUBSUB_SERVICE_ACCOUNT = 'push@example.iam.gserviceaccount.com'
    const keys = await generateKeyPair('RS256'); const publicKey = await importJWK(await exportJWK(keys.publicKey), 'RS256')
    const token = await new SignJWT({ email: process.env.MAILBOX_GOOGLE_PUBSUB_SERVICE_ACCOUNT, email_verified: true }).setProtectedHeader({ alg: 'RS256' }).setAudience(process.env.MAILBOX_GOOGLE_PUBSUB_AUDIENCE).setIssuer('https://accounts.google.com').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey)
    await expect(googleJWTVerifier(async () => publicKey)!(token)).resolves.toBeUndefined()
    const wrong = await new SignJWT({ email: 'other@example.com', email_verified: true }).setProtectedHeader({ alg: 'RS256' }).setAudience(process.env.MAILBOX_GOOGLE_PUBSUB_AUDIENCE).setIssuer('https://accounts.google.com').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey)
    await expect(googleJWTVerifier(async () => publicKey)!(wrong)).rejects.toThrow('notification_invalid')
    if (priorAudience === undefined) delete process.env.MAILBOX_GOOGLE_PUBSUB_AUDIENCE; else process.env.MAILBOX_GOOGLE_PUBSUB_AUDIENCE = priorAudience
    if (priorEmail === undefined) delete process.env.MAILBOX_GOOGLE_PUBSUB_SERVICE_ACCOUNT; else process.env.MAILBOX_GOOGLE_PUBSUB_SERVICE_ACCOUNT = priorEmail
  })
  it('reuses an active subscription and preserves client state on Graph PATCH', async () => {
    const mailbox = { id: 'mailbox', provider: 'microsoft', health: 'connected', primaryAddress: 'a@example.com', connectionMode: 'delegated' }; const revision = notificationCredentialRevision(mailbox)
    const row = { id: 'notice', mailbox: 'mailbox', provider: 'microsoft', credentialRevision: revision, subscriptionID: 'sub', clientStateHash: 'preserve', status: 'active', expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), renewFailureCount: 0 }
    const updates: any[] = []; const fake = { findByID: async () => mailbox, find: async () => ({ docs: [row] }), update: async (input: any) => { updates.push(input); return input } } as any
    const result = await renewMailboxNotifications(fake, 'mailbox', 'token', async (_url, init) => new Response(JSON.stringify({ id: 'sub', expirationDateTime: new Date(Date.now() + 45 * 60_000).toISOString(), resource: '/me/messages' }), { status: 200 }), new Date())
    expect(result.data.clientStateHash).toBe('preserve'); expect(updates[0].data.renewFailureCount).toBe(0)
  })
  it('backs off a failed renewal without calling Graph again', async () => {
    const mailbox = { id: 'mailbox', provider: 'microsoft', health: 'connected', connectionMode: 'delegated' }; const row = { id: 'notice', mailbox: 'mailbox', provider: 'microsoft', credentialRevision: notificationCredentialRevision(mailbox), subscriptionID: 'sub', status: 'failed', renewFailureCount: 2, nextRenewAttemptAt: new Date(Date.now() + 60_000).toISOString() }
    const fake = { findByID: async () => mailbox, find: async () => ({ docs: [row] }) } as any
    await expect(renewMailboxNotifications(fake, 'mailbox', 'token', async () => { throw new Error('must not call') })).rejects.toThrow('notification_backoff')
  })
})
