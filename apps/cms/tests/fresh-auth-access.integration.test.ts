import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLocalReq, getPayload, type PayloadRequest } from 'payload'
import { freshStaff } from '../src/access'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-fresh-auth-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-payload'

const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>
let owner: { id: string; email: string; name: string; roles: string[] }
let otherOwner: { id: string }
let token: string

beforeAll(async () => {
  payload = await getPayload({ config })
  owner = await payload.create({ collection: 'users', data: { email: 'fresh-owner@example.test', name: 'Fresh owner', roles: ['owner'] }, overrideAccess: true })
  otherOwner = await payload.create({ collection: 'users', data: { email: 'other-owner@example.test', name: 'Other owner', roles: ['owner'] }, overrideAccess: true })
})

beforeEach(async () => {
  await (payload.db as unknown as { client: { execute: (sql: string) => Promise<unknown> } }).client.execute('DELETE FROM auth_sessions')
  token = newOpaqueToken()
})

afterAll(async () => {
  await payload?.destroy()
  rmSync(directory, { recursive: true, force: true })
})

async function requestFor(user: { id: string; roles: string[]; disabled?: boolean }, authenticationAgeMs = 0): Promise<PayloadRequest> {
  const now = Date.now()
  await payload.create({
    collection: 'auth-sessions',
    data: {
      tokenHash: hashOpaqueToken(token),
      user: owner.id,
      authenticatedAt: new Date(now - authenticationAgeMs).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    },
    overrideAccess: true,
  })
  return createLocalReq({
    req: { headers: new Headers({ cookie: `${cookieName(SESSION_COOKIE)}=${token}` }) },
    user: { ...user, collection: 'users' } as never,
  }, payload)
}

const canMutateIdentity = async (req: PayloadRequest) => freshStaff(['owner'])({ req })

describe('fresh server-side authentication access (ENG-007)', () => {
  it('allows a canonical owner only when its opaque session was freshly authenticated', async () => {
    const req = await requestFor(owner)
    await expect(canMutateIdentity(req)).resolves.toBe(true)
  })

  it('denies a valid but stale session', async () => {
    const req = await requestFor(owner, 15 * 60_000 + 1)
    await expect(canMutateIdentity(req)).resolves.toBe(false)
  })

  it('does not trust a request user that does not match the opaque session owner', async () => {
    const req = await requestFor({ id: otherOwner.id, roles: ['owner'] })
    await expect(canMutateIdentity(req)).resolves.toBe(false)
  })

  it('re-reads the canonical user and denies a disabled owner despite a forged active request user', async () => {
    await payload.update({ collection: 'users', id: owner.id, data: { disabled: true }, overrideAccess: true })
    try {
      const req = await requestFor({ ...owner, disabled: false })
      await expect(canMutateIdentity(req)).resolves.toBe(false)
    } finally {
      await payload.update({ collection: 'users', id: owner.id, data: { disabled: false }, overrideAccess: true })
    }
  })
})
