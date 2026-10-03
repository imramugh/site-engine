import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { createInitialOwnerInvitation } from '../src/invitation-enrollment'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-initial-enrollment-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-payload'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

describe('initial owner invitation enrollment (ENG-007)', () => {
  it('creates no user, persists an unbound owner invitation, and prevents simultaneous bootstrap', async () => {
    const [first, second] = await Promise.allSettled([
      createInitialOwnerInvitation(payload, { email: 'first@example.test', provider: 'google', providerIssuer: 'https://issuer.example.test' }),
      createInitialOwnerInvitation(payload, { email: 'second@example.test', provider: 'google', providerIssuer: 'https://issuer.example.test' }),
    ])
    expect([first, second].filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
    expect((await payload.count({ collection: 'users', overrideAccess: true })).totalDocs).toBe(0)
    const invitations = await payload.find({ collection: 'invitations', overrideAccess: true, limit: 10 })
    expect(invitations.totalDocs).toBe(1)
    expect(invitations.docs[0]?.roles).toEqual(['owner'])
    expect(invitations.docs[0]?.requiredSubject).toBeNull()
  })
  it('allows a new initial invitation after the previous one expires, without creating an account', async () => {
    await payload.update({ collection: 'invitations', where: {}, data: { expiresAt: new Date(Date.now() - 60_000).toISOString() }, overrideAccess: true })
    await expect(createInitialOwnerInvitation(payload, { email: 'retry@example.test', provider: 'google', providerIssuer: 'https://issuer.example.test' })).resolves.toEqual(expect.any(String))
    const pending = await payload.find({ collection: 'invitations', overrideAccess: true })
    expect(pending.docs.map((invitation) => invitation.email)).toEqual(['retry@example.test'])
    expect((await payload.count({ collection: 'users', overrideAccess: true })).totalDocs).toBe(0)
  })
})
