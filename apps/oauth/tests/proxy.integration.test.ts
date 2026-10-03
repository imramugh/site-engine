import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createOAuthService } from '../src/server.js'

test('uses HTTPS forwarding only when trustProxy is explicitly enabled', async () => {
  const publicOrigin = 'https://issuer.example.test'
  const issuer = `${publicOrigin}/oauth`; const resource = `${publicOrigin}/mcp`
  const databasePath = join(tmpdir(), `site-engine-oauth-proxy-${process.pid}.sqlite`)
  const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' })
  const service = createOAuthService({
    issuer, resource, databasePath, trustProxy: true,
    cookieKeys: ['test-cookie-key-one', 'test-cookie-key-two'], jwks: { keys: [{ ...signingKey, kid: 'proxy-key', use: 'sig', alg: 'RS256' }] },
    sessionBridge: {
      resolve: async () => ({ id: 'proxy-user', sessionId: 'proxy-session', enabled: true, scopes: ['mcp:content:read'] }),
      find: async (id, sessionId) => id === 'proxy-user' && sessionId === 'proxy-session' ? { id, sessionId, enabled: true, scopes: ['mcp:content:read'] } : undefined,
    },
  })
  const proxy = createServer((request, response) => service.server.emit('request', request, response))
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address(); assert.ok(address && typeof address !== 'string')
  const localOrigin = `http://127.0.0.1:${address.port}`
  const forwarded = { host: 'issuer.example.test', 'x-forwarded-proto': 'https' }
  try {
    const registration = await fetch(`${localOrigin}/oauth/reg`, { method: 'POST', headers: { ...forwarded, 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none', response_types: ['code'], scope: 'mcp:content:read' }) })
    assert.equal(registration.status, 201)
    const client = await registration.json() as { client_id: string }
    const verifier = randomBytes(48).toString('base64url'); const challenge = createHash('sha256').update(verifier).digest('base64url')
    const authorization = new URL(`${localOrigin}/oauth/auth`)
    authorization.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://127.0.0.1/callback', scope: 'mcp:content:read', resource, code_challenge: challenge, code_challenge_method: 'S256' }).toString()
    const started = await fetch(authorization, { redirect: 'manual', headers: forwarded })
    assert.equal(started.status, 303)
    const cookies = new Map(started.headers.getSetCookie().map((value) => { const pair = value.split(';', 1)[0]!; return [pair.split('=', 1)[0]!, pair] }))
    const cookie = () => [...cookies.values()].join('; ')
    assert.match(started.headers.getSetCookie().join('\n'), /Secure/i)
    const interaction = started.headers.get('location'); assert.ok(interaction)
    const interactionURL = new URL(interaction, localOrigin)
    const page = await fetch(interactionURL, { headers: { ...forwarded, cookie: cookie() } })
    assert.equal(page.status, 200)
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1]; assert.ok(csrf)
    const confirmed = await fetch(interactionURL, { method: 'POST', redirect: 'manual', headers: { ...forwarded, cookie: cookie(), origin: publicOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, decision: 'allow' }) })
    assert.equal(confirmed.status, 303)
    for (const value of confirmed.headers.getSetCookie()) { const pair = value.split(';', 1)[0]!; cookies.set(pair.split('=', 1)[0]!, pair) }
    let next = new URL(confirmed.headers.get('location')!, publicOrigin); let code: string | null = null
    for (let redirects = 0; redirects < 4; redirects++) {
      if (next.origin === 'http://127.0.0.1' && next.pathname === '/callback') { code = next.searchParams.get('code'); break }
      const response = await fetch(`${localOrigin}${next.pathname}${next.search}`, { redirect: 'manual', headers: { ...forwarded, cookie: cookie() } })
      for (const value of response.headers.getSetCookie()) { const pair = value.split(';', 1)[0]!; cookies.set(pair.split('=', 1)[0]!, pair) }
      if (response.status === 200) {
        const repeatedCsrf = /name="csrf" value="([^"]+)"/.exec(await response.text())?.[1]; assert.ok(repeatedCsrf)
        const repeated = await fetch(`${localOrigin}${next.pathname}${next.search}`, { method: 'POST', redirect: 'manual', headers: { ...forwarded, cookie: cookie(), origin: publicOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: repeatedCsrf, decision: 'allow' }) })
        assert.equal(repeated.status, 303)
        for (const value of repeated.headers.getSetCookie()) { const pair = value.split(';', 1)[0]!; cookies.set(pair.split('=', 1)[0]!, pair) }
        next = new URL(repeated.headers.get('location')!, publicOrigin)
        continue
      }
      assert.equal(response.status, 303)
      const location = response.headers.get('location'); assert.ok(location)
      next = new URL(location, publicOrigin)
      if (next.origin === 'http://127.0.0.1' && next.pathname === '/callback') { code = next.searchParams.get('code'); break }
    }
    assert.ok(code)
    const token = await fetch(`${localOrigin}/oauth/token`, { method: 'POST', headers: { ...forwarded, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1/callback', client_id: client.client_id, code_verifier: verifier, resource }) })
    assert.equal(token.status, 200)
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve())); service.close(); rmSync(databasePath, { force: true })
  }
}, 15_000)
