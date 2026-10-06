import { afterAll, beforeAll, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPayload } from 'payload'

const directory = mkdtempSync(join(tmpdir(), 'mailbox-oauth-'))
Object.assign(process.env, { DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`, PAYLOAD_SECRET: 'mailbox-oauth-test-secret-long-enough', PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.example.test', INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64url'), MAILBOX_MICROSOFT_CLIENT_ID: 'client', MAILBOX_MICROSOFT_CLIENT_SECRET: 'secret' })
const { default: config } = await import('../payload.config.js')
const { startMailboxOAuth, completeMailboxOAuth, decryptMailboxOAuthCredential, refreshAndPersistMailboxOAuth } = await import('../src/mailbox-oauth.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload.destroy(); rmSync(directory, { recursive: true, force: true }); for (const key of ['DATABASE_URI', 'PAYLOAD_SECRET', 'PAYLOAD_PUBLIC_SERVER_URL', 'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY', 'MAILBOX_MICROSOFT_CLIENT_ID', 'MAILBOX_MICROSOFT_CLIENT_SECRET']) delete process.env[key] })

test('persists only encrypted delegated credentials and rejects a replayed callback', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'oauth-owner@example.test', name: 'Owner', roles: ['owner'] }, overrideAccess: true })
  const authorization = new URL(await startMailboxOAuth(payload, 'microsoft', owner.id, 'session-a')); const state = authorization.searchParams.get('state')!
  const fetcher = async (url: string) => url.includes('/token') ? Response.json({ access_token: 'access-token', refresh_token: 'refresh-token' }) : Response.json({ mail: 'mailbox@example.test', userPrincipalName: 'mailbox@example.test' })
  await expect(completeMailboxOAuth(payload, 'microsoft', state, 'provider-code', owner.id, 'session-b', fetcher)).rejects.toThrow('invalid_callback')
  const mailbox = await completeMailboxOAuth(payload, 'microsoft', state, 'provider-code', owner.id, 'session-a', fetcher)
  expect(mailbox).toMatchObject({ provider: 'microsoft', primaryAddress: 'mailbox@example.test', health: 'connected' })
  const stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true })
  expect(String(stored.encryptedCredential)).not.toContain('refresh-token')
  expect(JSON.parse(decryptMailboxOAuthCredential(String(stored.encryptedCredential), 'microsoft'))).toEqual({ refreshToken: 'refresh-token' })
  await expect(completeMailboxOAuth(payload, 'microsoft', state, 'provider-code', owner.id, 'session-a', fetcher)).rejects.toThrow('invalid_callback')
  expect((await payload.find({ collection: 'mailbox-configurations', overrideAccess: true })).docs).toHaveLength(1)
})

test('rotates a refresh token once and rejects a stale credential revision', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'refresh-owner@example.test', name: 'Owner', roles: ['owner'] }, overrideAccess: true })
  const state = new URL(await startMailboxOAuth(payload, 'microsoft', owner.id, 'refresh-session')).searchParams.get('state')!
  const provider = async (url: string) => url.includes('/token') ? Response.json({ access_token: 'access', refresh_token: 'old-refresh' }) : Response.json({ mail: 'refresh@example.test' })
  const mailbox = await completeMailboxOAuth(payload, 'microsoft', state, 'code', owner.id, 'refresh-session', provider)
  const before = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true })
  await expect(refreshAndPersistMailboxOAuth(payload, before, async () => Response.json({ access_token: 'next-access', refresh_token: 'new-refresh' }))).resolves.toMatchObject({ accessToken: 'next-access' })
  const after = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true })
  expect(JSON.parse(decryptMailboxOAuthCredential(String(after.encryptedCredential), 'microsoft'))).toEqual({ refreshToken: 'new-refresh' })
  await expect(refreshAndPersistMailboxOAuth(payload, before, async () => Response.json({ access_token: 'again', refresh_token: 'bad' }))).rejects.toThrow('credential_changed')
})

test('rejects another Owner, expiry, and provider failure without a connected mailbox', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'oauth-primary@example.test', name: 'Primary', roles: ['owner'] }, overrideAccess: true })
  const other = await payload.create({ collection: 'users', data: { email: 'oauth-other@example.test', name: 'Other', roles: ['owner'] }, overrideAccess: true })
  const state = new URL(await startMailboxOAuth(payload, 'microsoft', owner.id, 'owner-session')).searchParams.get('state')!
  const provider = async (url: string) => url.includes('/token') ? Response.json({ access_token: 'access', refresh_token: 'refresh' }) : Response.json({ mail: 'owner@example.test' })
  await expect(completeMailboxOAuth(payload, 'microsoft', state, 'code', other.id, 'owner-session', provider)).rejects.toThrow('invalid_callback')
  let failedCalls = 0
  const failedProvider = async () => { failedCalls += 1; return Response.json({ error: 'invalid_grant' }, { status: 400 }) }
  await expect(completeMailboxOAuth(payload, 'microsoft', state, 'code', owner.id, 'owner-session', failedProvider)).rejects.toThrow('provider_rejected')
  await expect(completeMailboxOAuth(payload, 'microsoft', state, 'code', owner.id, 'owner-session', failedProvider)).rejects.toThrow('invalid_callback')
  expect(failedCalls).toBe(1)
  expect((await payload.find({ collection: 'mailbox-configurations', overrideAccess: true })).docs.some(item => item.primaryAddress === 'owner@example.test')).toBe(false)
  const expired = new URL(await startMailboxOAuth(payload, 'microsoft', owner.id, 'expired-session')).searchParams.get('state')!
  const transaction = (await (payload as any).find({ collection: 'mailbox-oauth-transactions', where: { stateHash: { exists: true } }, sort: '-createdAt', limit: 1, overrideAccess: true })).docs[0]
  await (payload as any).update({ collection: 'mailbox-oauth-transactions', id: transaction.id, data: { expiresAt: new Date(Date.now() - 1_000).toISOString() }, overrideAccess: true, context: { mailboxInternal: true } })
  await expect(completeMailboxOAuth(payload, 'microsoft', expired, 'code', owner.id, 'expired-session', provider)).rejects.toThrow('invalid_callback')
})

test('bounds refresh responses and never follows a refresh-token redirect', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'refresh-transport@example.test', name: 'Refresh transport', roles: ['owner'] }, overrideAccess: true })
  const state = new URL(await startMailboxOAuth(payload, 'microsoft', owner.id, 'refresh-transport-session')).searchParams.get('state')!
  const mailbox = await completeMailboxOAuth(payload, 'microsoft', state, 'code', owner.id, 'refresh-transport-session', async (url) => url.includes('/token') ? Response.json({ access_token: 'access', refresh_token: 'refresh' }) : Response.json({ mail: 'refresh-transport@example.test' }))
  const stored = await payload.findByID({ collection: 'mailbox-configurations', id: mailbox.id, overrideAccess: true })
  await expect(refreshAndPersistMailboxOAuth(payload, stored, async (_url, init) => {
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(String(init.body)).toContain('grant_type=refresh_token')
    return new Response('x'.repeat(65_537), { status: 200 })
  })).rejects.toThrow('provider_rejected')
  await expect(refreshAndPersistMailboxOAuth(payload, stored, async () => Response.json({ access_token: '' }))).rejects.toThrow('provider_rejected')
  await expect(refreshAndPersistMailboxOAuth(payload, stored, async () => { throw new Error('network failure') })).rejects.toThrow('provider_rejected')
})
