import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload, type Payload } from 'payload'
import { authorizationDigest, authorizeMailDraft, consumeMailAuthorization, revokeMailAuthorization } from '../src/mail-authorizations'
import { hashOpaqueToken, newOpaqueToken } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-mail-authorizations-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-local-mail-authorizations'
const { default: config } = await import('../payload.config.js')
let payload: Payload

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

type Actor = { id: string; sessionToken: string }
type Draft = { id: string; recipient: string; sender: string; subject: string; body: string; attachmentHashes: string[]; lead: string; revision: number }

async function actor(role: 'owner' | 'sales'): Promise<Actor> {
  const user = await payload.create({ collection: 'users', data: { email: `${role}-${randomUUID()}@example.test`, name: role, roles: [role] }, overrideAccess: true })
  const sessionToken = newOpaqueToken()
  const now = Date.now()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(sessionToken), user: user.id, authenticatedAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }, overrideAccess: true })
  return { id: user.id, sessionToken }
}

async function draft(): Promise<Draft> {
  const lead = await payload.create({
    collection: 'inquiries',
    data: { email: `lead-${randomUUID()}@example.test`, message: 'Please send more information about this project.', topic: 'general', sourcePage: '/contact', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: randomUUID(), stage: 'new' },
    draft: false, overrideAccess: true,
  })
  return await payload.create({
    collection: 'mail-drafts',
    data: { lead: lead.id, threadID: randomUUID(), recipient: lead.email, sender: 'team@example.test', subject: 'Project follow-up', body: 'Thank you for your enquiry.', attachmentHashes: ['first-attachment'], revision: 1, state: 'prepared' },
    draft: false, overrideAccess: true,
  }) as Draft
}

const future = () => new Date(Date.now() + 60_000)

describe('local mail authorization transactions', () => {
  it('consumes a grant exactly once when two SQLite transactions race', async () => {
    const owner = await actor('owner')
    const prepared = await draft()
    const grant = await authorizeMailDraft(payload, owner, prepared.id, future())
    const authorizedDraft = await payload.findByID({ collection: 'mail-drafts', id: prepared.id, depth: 0, overrideAccess: true })
    expect({ grantRevision: grant.draftRevision, grantDigest: grant.digest, draftRevision: authorizedDraft.revision, digest: authorizationDigest(authorizedDraft as Draft), state: authorizedDraft.state }).toEqual(expect.objectContaining({ grantRevision: 1, draftRevision: 1, state: 'authorized' }))

    const results = await Promise.allSettled([
      consumeMailAuthorization(payload, owner, grant.id),
      consumeMailAuthorization(payload, owner, grant.id),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)

    const persisted = await payload.findByID({ collection: 'mail-authorizations', id: grant.id, depth: 0, overrideAccess: true })
    expect(persisted.consumedAt).toBeTruthy()
    const audits = await payload.find({ collection: 'audit-events', where: { event: { equals: 'mail.authorization_consumed' } }, depth: 0, limit: 0, pagination: false, overrideAccess: true })
    expect(audits.docs.filter((event) => (event.detail as { grant?: string }).grant === grant.id)).toHaveLength(1)
  })

  it.each([
    ['recipient', 'another@example.test'],
    ['body', 'The approved text was edited.'],
    ['attachmentHashes', ['first-attachment', 'second-attachment']],
  ] as const)('invalidates the grant when its %s changes', async (field, value) => {
    const owner = await actor('owner')
    const prepared = await draft()
    const grant = await authorizeMailDraft(payload, owner, prepared.id, future())
    const changed = await payload.update({ collection: 'mail-drafts', id: prepared.id, data: { [field]: value }, overrideAccess: true }) as Draft

    expect(changed.revision).toBe(prepared.revision + 1)
    expect(authorizationDigest(changed)).not.toBe(grant.digest)
    const invalidated = await payload.findByID({ collection: 'mail-authorizations', id: grant.id, depth: 0, overrideAccess: true })
    expect(invalidated.revokedAt).toBeTruthy()
    await expect(consumeMailAuthorization(payload, owner, grant.id)).rejects.toThrow('authorization_not_usable')
  })

  it('rejects expired and revoked grants without consuming them', async () => {
    const owner = await actor('owner')
    const expiredDraft = await draft()
    const expired = await authorizeMailDraft(payload, owner, expiredDraft.id, future())
    await expect(consumeMailAuthorization(payload, owner, expired.id, new Date('2099-01-01T00:00:00.000Z'))).rejects.toThrow('authorization_not_usable')

    const revokedDraft = await draft()
    const revoked = await authorizeMailDraft(payload, owner, revokedDraft.id, future())
    await revokeMailAuthorization(payload, owner, revoked.id)
    await expect(consumeMailAuthorization(payload, owner, revoked.id)).rejects.toThrow('authorization_not_usable')
    const grants = await Promise.all([expired.id, revoked.id].map((id) => payload.findByID({ collection: 'mail-authorizations', id, depth: 0, overrideAccess: true })))
    expect(grants.map((grant) => grant.consumedAt)).toEqual([null, null])
  })

  it('requires a current owner for authorization, revocation, and consumption', async () => {
    const owner = await actor('owner')
    const sales = await actor('sales')
    const prepared = await draft()
    await expect(authorizeMailDraft(payload, sales, prepared.id, future())).rejects.toThrow('owner_authorization_required')
    const grant = await authorizeMailDraft(payload, owner, prepared.id, future())
    await expect(revokeMailAuthorization(payload, sales, grant.id)).rejects.toThrow('owner_authorization_required')
    await expect(consumeMailAuthorization(payload, sales, grant.id)).rejects.toThrow('owner_authorization_required')
  })

  it('verifies the canonical owner and fresh authentication instead of caller role claims', async () => {
    const owner = await actor('owner')
    const sales = await actor('sales')
    const prepared = await draft()
    await expect(authorizeMailDraft(payload, { ...sales, roles: ['owner'] } as unknown as Actor, prepared.id, future())).rejects.toThrow('owner_authorization_required')
    const session = await payload.find({ collection: 'auth-sessions', where: { tokenHash: { equals: hashOpaqueToken(owner.sessionToken) } }, limit: 1, depth: 0, overrideAccess: true })
    await payload.update({ collection: 'auth-sessions', id: session.docs[0]!.id, data: { authenticatedAt: new Date(Date.now() - 16 * 60_000).toISOString() }, overrideAccess: true })
    await expect(authorizeMailDraft(payload, owner, prepared.id, future())).rejects.toThrow('owner_authorization_required')
  })

  it('supersedes an earlier grant so a draft has one active authorization', async () => {
    const owner = await actor('owner')
    const prepared = await draft()
    const first = await authorizeMailDraft(payload, owner, prepared.id, future())
    const second = await authorizeMailDraft(payload, owner, prepared.id, future())
    const grants = await payload.find({ collection: 'mail-authorizations', where: { draft: { equals: prepared.id } }, depth: 0, limit: 0, pagination: false, overrideAccess: true })
    expect(grants.docs.filter((grant) => !grant.revokedAt && !grant.consumedAt)).toHaveLength(1)
    expect((await payload.findByID({ collection: 'mail-authorizations', id: first.id, depth: 0, overrideAccess: true })).revokedAt).toBeTruthy()
    await expect(consumeMailAuthorization(payload, owner, first.id)).rejects.toThrow('authorization_not_usable')
    await expect(consumeMailAuthorization(payload, owner, second.id)).resolves.toMatchObject({ id: second.id })
  })

  it('rolls back consumption if its mandatory audit write fails', async () => {
    const owner = await actor('owner')
    const prepared = await draft()
    const grant = await authorizeMailDraft(payload, owner, prepared.id, future())
    const originalCreate = payload.create.bind(payload)
    ;(payload as unknown as { create: typeof payload.create }).create = async (args) => {
      const audit = args as { collection?: string; data?: { event?: string } }
      if (audit.collection === 'audit-events' && audit.data?.event === 'mail.authorization_consumed') throw new Error('mandatory_audit_failure')
      return originalCreate(args as never)
    }
    try {
      await expect(consumeMailAuthorization(payload, owner, grant.id)).rejects.toThrow('mandatory_audit_failure')
    } finally {
      ;(payload as unknown as { create: typeof payload.create }).create = originalCreate
    }
    const persistedGrant = await payload.findByID({ collection: 'mail-authorizations', id: grant.id, depth: 0, overrideAccess: true })
    const persistedDraft = await payload.findByID({ collection: 'mail-drafts', id: prepared.id, depth: 0, overrideAccess: true })
    expect(persistedGrant.consumedAt).toBeNull()
    expect(persistedDraft.state).toBe('authorized')
  })
})
