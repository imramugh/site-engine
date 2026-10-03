import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-preview-session-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-payload'

const { default: config } = await import('../payload.config.js')
const route = await import('../app/api/auth/preview/session/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

async function sessionFor(role: 'owner' | 'approver' | 'editor' | 'sales', options: { disabled?: boolean; expiresAt?: string; revokedAt?: string } = {}) {
  const user = await payload.create({
    collection: 'users',
    data: { email: `${role}-${newOpaqueToken()}@example.test`, name: `Preview ${role}`, roles: [role], disabled: options.disabled ?? false },
    overrideAccess: true,
  })
  const token = newOpaqueToken()
  const now = new Date().toISOString()
  await payload.create({
    collection: 'auth-sessions',
    data: {
      tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: now, lastSeenAt: now,
      expiresAt: options.expiresAt ?? new Date(Date.now() + 60_000).toISOString(), revokedAt: options.revokedAt,
    },
    overrideAccess: true,
  })
  return token
}

async function invoke(headers?: HeadersInit) {
  const response = await route.GET(new Request('http://localhost/api/auth/preview/session', { headers }))
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.text()).toBe('')
  return response
}

const sessionHeaders = (token: string) => ({ cookie: `${cookieName(SESSION_COOKIE)}=${token}` })

describe('preview session auth_request endpoint (ENG-007)', () => {
  it.each(['owner', 'approver', 'editor'] as const)('authorizes an enabled %s session from real SQLite', async (role) => {
    expect((await invoke(sessionHeaders(await sessionFor(role)))).status).toBe(204)
  })

  it('rejects a disabled canonical user even with a valid session cookie', async () => {
    expect((await invoke(sessionHeaders(await sessionFor('editor', { disabled: true })))).status).toBe(401)
  })

  it('rejects expired and revoked server sessions', async () => {
    expect((await invoke(sessionHeaders(await sessionFor('editor', { expiresAt: new Date(Date.now() - 1_000).toISOString() })))).status).toBe(401)
    expect((await invoke(sessionHeaders(await sessionFor('editor', { revokedAt: new Date().toISOString() })))).status).toBe(401)
  })

  it('denies an authenticated role that cannot read draft content', async () => {
    expect((await invoke(sessionHeaders(await sessionFor('sales')))).status).toBe(403)
  })

  it('rejects missing cookies and bearer credentials without a browser session', async () => {
    expect((await invoke()).status).toBe(401)
    expect((await invoke({ authorization: 'Bearer synthetic-mcp-token' })).status).toBe(401)
  })
})
