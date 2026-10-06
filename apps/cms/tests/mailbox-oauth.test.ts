import { afterEach, describe, expect, it } from 'vitest'
import { mailboxOAuthSettings, refreshMailboxOAuth, startMailboxOAuth } from '../src/mailbox-oauth'

afterEach(() => { for (const key of Object.keys(process.env)) if (key.startsWith('MAILBOX_') || key === 'PAYLOAD_PUBLIC_SERVER_URL' || key === 'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY') delete process.env[key] })
describe('mailbox OAuth provider contracts', () => {
  it('uses fixed delegated scopes and exact callbacks', () => {
    Object.assign(process.env, { PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.example.test', MAILBOX_MICROSOFT_CLIENT_ID: 'id', MAILBOX_MICROSOFT_CLIENT_SECRET: 'secret', MAILBOX_GOOGLE_CLIENT_ID: 'id', MAILBOX_GOOGLE_CLIENT_SECRET: 'secret' })
    expect(mailboxOAuthSettings('microsoft')).toMatchObject({ redirectURI: 'https://cms.example.test/api/email-workspace/oauth/microsoft/callback', scopes: expect.arrayContaining(['offline_access', 'User.Read', 'Mail.Read', 'Mail.Send']) })
    expect(mailboxOAuthSettings('google')).toMatchObject({ redirectURI: 'https://cms.example.test/api/email-workspace/oauth/google/callback', scopes: expect.arrayContaining(['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.settings.basic']) })
  })
  it('requests Google offline consent so reconnecting receives a refresh token', async () => {
    Object.assign(process.env, { PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.example.test', INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64url'), MAILBOX_GOOGLE_CLIENT_ID: 'id', MAILBOX_GOOGLE_CLIENT_SECRET: 'secret' })
    const authorization = new URL(await startMailboxOAuth({ create: async () => undefined } as any, 'google', 'owner', 'session-a'))
    expect(authorization.searchParams.get('access_type')).toBe('offline')
    expect(authorization.searchParams.get('prompt')).toBe('consent')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
  })
  it('refreshes a stored provider token through the fixed token endpoint', async () => {
    Object.assign(process.env, { PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.example.test', INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64url'), MAILBOX_MICROSOFT_CLIENT_ID: 'id', MAILBOX_MICROSOFT_CLIENT_SECRET: 'secret' })
    const { startMailboxOAuth, decryptMailboxOAuthCredential } = await import('../src/mailbox-oauth')
    const docs: any[] = []; const payload: any = { create: async (v:any) => { docs.push(v.data); return v.data } }
    await startMailboxOAuth(payload, 'microsoft', 'owner', 'session-a')
    const result = await refreshMailboxOAuth({ provider: 'microsoft', encryptedCredential: docs[0].verifier }, async () => Response.json({ access_token: 'next' })).catch(() => undefined)
    expect(result).toBeUndefined()
    expect(() => decryptMailboxOAuthCredential(docs[0].verifier, 'google')).toThrow()
  })
})
