import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { hashOpaqueToken, OIDC_TRANSACTION_COOKIE, cookieName } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-auth-start-rate-limit-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-payload'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://localhost'
process.env.OIDC_GOOGLE_CLIENT_ID = 'test-client'
process.env.OIDC_GOOGLE_CLIENT_SECRET = 'test-secret'
process.env.AUTH_TRANSACTION_MAX_RECORDS = '2'
process.env.AUTH_TRANSACTION_START_COOLDOWN_SECONDS = '60'

let issuer = ''
let payload: Awaited<ReturnType<typeof getPayload>>
let server: ReturnType<typeof createServer>
let start: (request: Request, context: { params: Promise<{ provider: string }> }) => Promise<Response>

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url || '/', issuer)
    response.setHeader('content-type', 'application/json')
    if (url.pathname === '/.well-known/openid-configuration') {
      response.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], id_token_signing_alg_values_supported: ['RS256'] }))
      return
    }
    if (url.pathname === '/jwks') { response.end(JSON.stringify({ keys: [] })); return }
    response.statusCode = 404
    response.end('{}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  issuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  process.env.OIDC_GOOGLE_ISSUER_URL = issuer

  const { default: config } = await import('../payload.config.js')
  payload = await getPayload({ config })
  const route = await import('../app/api/auth/[provider]/route.js')
  start = route.GET
})

beforeEach(async () => {
  await (payload.db as unknown as { client: { execute: (sql: string) => Promise<unknown> } }).client.execute('DELETE FROM auth_transactions')
})

afterAll(async () => {
  await payload?.destroy()
  server?.close()
  rmSync(directory, { recursive: true, force: true })
})

const invoke = (cookie?: string) => start(new Request('http://localhost/api/auth/google', { headers: cookie ? { cookie } : undefined }), { params: Promise.resolve({ provider: 'google' }) })

async function transaction(state: string, expiresAt: Date) {
  return payload.create({
    collection: 'auth-transactions',
    data: { stateHash: hashOpaqueToken(state), nonce: `nonce-${state}`, verifier: `verifier-${state}`, provider: 'google', expiresAt: expiresAt.toISOString() },
    overrideAccess: true,
  })
}

describe('bounded OIDC sign-in starts (ENG-007)', () => {
  it('applies a per-browser/provider cooldown using only the server-issued state cookie', async () => {
    const first = await invoke()
    expect(first.status).toBe(307)
    const setCookie = first.headers.get('set-cookie')
    const cookie = setCookie?.match(new RegExp(`${cookieName(OIDC_TRANSACTION_COOKIE)}=[^;]+`))?.[0]
    expect(cookie).toBeDefined()

    const second = await invoke(cookie)
    expect(second.status).toBe(429)
    expect((await payload.count({ collection: 'auth-transactions', overrideAccess: true })).totalDocs).toBe(1)
  })

  it('prunes expired transactions before allocating a new state', async () => {
    await transaction('expired', new Date(Date.now() - 1_000))
    await transaction('active', new Date(Date.now() + 60_000))

    expect((await invoke()).status).toBe(307)
    const transactions = await payload.find({ collection: 'auth-transactions', limit: 10, overrideAccess: true })
    expect(transactions.totalDocs).toBe(2)
    expect(transactions.docs.some((entry) => entry.stateHash === hashOpaqueToken('expired'))).toBe(false)
  })

  it('refuses new starts at the retained transaction cap without trusting client IP headers', async () => {
    await transaction('active-one', new Date(Date.now() + 60_000))
    await transaction('active-two', new Date(Date.now() + 60_000))

    const response = await start(new Request('http://localhost/api/auth/google', { headers: { 'x-forwarded-for': '127.0.0.1' } }), { params: Promise.resolve({ provider: 'google' }) })
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('60')
    expect((await payload.count({ collection: 'auth-transactions', overrideAccess: true })).totalDocs).toBe(2)
  })
})
