import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import { getPayload } from 'payload'
import { createHttpSessionBridge } from '../../oauth/src/session-bridge.js'
import { createOAuthService } from '../../oauth/src/server.js'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'
import { handleOAuthSessionBridge } from '../src/oauth-session-bridge'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-real-oauth-bridge-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-payload'
process.env.OAUTH_INTROSPECTION_SECRET = 'real-bridge-introspection-secret'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>

async function port() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === 'string') throw new Error('no port')
  return address.port
}

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }); delete process.env.OAUTH_INTROSPECTION_SECRET })

test('real OAuth tokens can be safely listed and their full family revoked by management ID', async () => {
  const bridgeSecret = 'real-bridge-secret'
  const cmsPort = await port(); const cmsOrigin = `http://127.0.0.1:${cmsPort}`
  const cms = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const response = await handleOAuthSessionBridge(new Request(`${cmsOrigin}${incoming.url}`, { method: incoming.method, headers: incoming.headers as HeadersInit, body: chunks.length ? Buffer.concat(chunks) : undefined }), payload, bridgeSecret)
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()))
  })
  await new Promise<void>((resolve) => cms.listen(cmsPort, '127.0.0.1', resolve))
  const oauthPort = await port(); const origin = `http://127.0.0.1:${oauthPort}`; const issuer = `${origin}/oauth`; const resource = `${origin}/mcp`
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' })
  const oauth = createOAuthService({ issuer, resource, databasePath: join(directory, 'oauth.sqlite'), cookieKeys: ['one-long-test-key', 'two-long-test-key'], jwks: { keys: [{ ...key, kid: 'real', use: 'sig', alg: 'RS256' }] }, sessionBridge: createHttpSessionBridge({ cmsOrigin, secret: bridgeSecret }) })
  await new Promise<void>((resolve) => oauth.server.listen(oauthPort, '127.0.0.1', resolve))
  try {
    const user = await payload.create({ collection: 'users', data: { email: 'real-oauth@example.test', name: 'Real OAuth', roles: ['editor'] }, overrideAccess: true })
    const sessionToken = newOpaqueToken(); const now = new Date().toISOString()
    const session = await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(sessionToken), user: user.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
    const registration = await fetch(`${issuer}/reg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Desktop', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none', response_types: ['code'], scope: 'mcp:content:read offline_access' }) })
    const client = await registration.json() as { client_id: string }; assert.equal(registration.status, 201)
    const verifier = randomBytes(48).toString('base64url'); const challenge = createHash('sha256').update(verifier).digest('base64url')
    const authorization = `${issuer}/auth?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://127.0.0.1/callback', scope: 'mcp:content:read offline_access', resource, code_challenge: challenge, code_challenge_method: 'S256' })}`
    const cookies = new Map<string, string>([[cookieName(SESSION_COOKIE), `${cookieName(SESSION_COOKIE)}=${sessionToken}`]])
    let next = new URL(authorization); let callback: URL | undefined
    for (let count = 0; count < 8; count++) {
      const response = await fetch(next, { redirect: 'manual', headers: { cookie: [...cookies.values()].join('; ') } })
      for (const value of response.headers.getSetCookie()) { const pair = value.split(';', 1)[0]!; cookies.set(pair.split('=', 1)[0]!, pair) }
      if (response.status === 200) {
        const csrf = /name="csrf" value="([^"]+)"/.exec(await response.text())?.[1]; assert.ok(csrf)
        const confirmed = await fetch(next, { method: 'POST', redirect: 'manual', headers: { cookie: [...cookies.values()].join('; '), origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, decision: 'allow' }) })
        const location = confirmed.headers.get('location'); assert.ok(location); next = new URL(location, issuer); continue
      }
      const location = response.headers.get('location'); assert.ok(location); next = new URL(location, issuer)
      if (next.origin === 'http://127.0.0.1' && next.pathname === '/callback') { callback = next; break }
    }
    assert.ok(callback); const code = callback.searchParams.get('code'); assert.ok(code)
    const bridgeValidation = await fetch(`${cmsOrigin}/api/internal/oauth/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-oauth-bridge-secret': bridgeSecret }, body: JSON.stringify({ operation: 'validate', sessionId: session.id, userId: user.id }) })
    assert.equal(bridgeValidation.status, 200)
    const tokenResponse = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1/callback', client_id: client.client_id, code_verifier: verifier, resource }) })
    assert.equal(tokenResponse.status, 200)
    const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string }
    const introspect = () => fetch(`${origin}/internal/introspect`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-oauth-introspection-secret': 'real-bridge-introspection-secret' }, body: JSON.stringify({ token: tokens.access_token, resource }) })
    assert.equal((await introspect()).status, 200); assert.equal((await (await introspect()).json() as { active: boolean }).active, true)
    const manage = (body: object) => fetch(`${origin}/internal/grants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-oauth-introspection-secret': 'real-bridge-introspection-secret' }, body: JSON.stringify(body) })
    const ownList = await manage({ operation: 'list', userId: user.id }); assert.equal(ownList.status, 200)
    const listed = await ownList.json() as { grants: Array<{ managementId: string; userId: string; clientName: string; scopes: string[]; sessionId?: string }> }
    assert.equal(listed.grants.length, 1); assert.equal(listed.grants[0]?.userId, user.id); assert.equal(listed.grants[0]?.clientName, 'Claude Desktop'); assert.deepEqual(listed.grants[0]?.scopes, ['mcp:content:read']); assert.equal(listed.grants[0]?.sessionId, undefined)
    assert.deepEqual(await (await manage({ operation: 'list', userId: 'different-user' })).json(), { grants: [] })
    assert.equal((await manage({ operation: 'revoke', managementId: listed.grants[0]!.managementId, userId: 'different-user' })).status, 404)
    assert.equal((await manage({ operation: 'revoke', managementId: listed.grants[0]!.managementId, userId: user.id })).status, 200)
    assert.deepEqual(await (await introspect()).json(), { active: false })
    const revokedRefresh = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, resource }) })
    assert.equal(revokedRefresh.status, 400)
  } finally {
    await new Promise<void>((resolve) => oauth.server.close(() => resolve())); oauth.close()
    await new Promise<void>((resolve) => cms.close(() => resolve()))
  }
}, 30_000)
