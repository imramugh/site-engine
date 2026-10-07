import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOTP } from 'otpauth'
import { getPayload } from 'payload'
import { createUserInvitation } from '../src/user-management'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-local-enrollment-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-local-enrollment-payload-secret-that-is-long-enough'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'https://cms.example.test'
process.env.EMERGENCY_TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64url')
const { default: config } = await import('../payload.config')
const { POST } = await import('../app/api/auth/enroll/route')
let payload: Awaited<ReturnType<typeof getPayload>>
let owner: any

const request = (body: Record<string, unknown>) => new Request('https://cms.example.test/api/auth/enroll', { method: 'POST', headers: { origin: 'https://cms.example.test', 'content-type': 'application/json' }, body: JSON.stringify(body) })
const tokenOf = (url: string) => new URL(url).hash.slice('#invite='.length)

beforeAll(async () => { payload = await getPayload({ config }) })
beforeEach(async () => {
  for (const table of ['audit_events', 'auth_sessions', 'invitations', 'users']) await (payload.db as any).client.execute(`DELETE FROM ${table}`)
  owner = await payload.create({ collection: 'users', data: { email: 'owner@example.test', name: 'Owner', roles: ['owner'] }, overrideAccess: true })
})
afterAll(async () => { await payload.destroy(); rmSync(directory, { recursive: true, force: true }) })

describe('local invitation enrollment', () => {
  it('does not create a user before proof, then atomically enrolls one local credential', async () => {
    const invitation = await createUserInvitation(payload, owner, { email: 'editor@example.test', roles: ['editor'] })
    const token = tokenOf(invitation.inviteURL)
    const prepared = await POST(request({ action: 'prepare', token }))
    expect(prepared.status).toBe(200)
    const enrollment = await prepared.json() as { otpauthURI: string; email: string }
    expect(enrollment.email).toBe('editor@example.test')
    expect(enrollment.otpauthURI).toContain('otpauth://totp/')
    const existingOwner = await payload.findByID({ collection: 'users', id: owner.id, overrideAccess: true })
    expect((await payload.count({ collection: 'users', overrideAccess: true })).totalDocs).toBe(1)
    const seed = new URL(enrollment.otpauthURI).searchParams.get('secret')!
    const code = new TOTP({ secret: seed, algorithm: 'SHA1', digits: 6, period: 30 }).generate()
    const [first, second] = await Promise.all([POST(request({ action: 'confirm', token, code, name: 'Editor' })), POST(request({ action: 'confirm', token, code, name: 'Editor' }))])
    expect([first.status, second.status].sort()).toEqual([200, 403])
    const completed = await (first.status === 200 ? first : second).json() as { recoveryCodes?: string[] }
    expect(completed.recoveryCodes).toHaveLength(8)
    expect((await payload.count({ collection: 'auth-sessions', overrideAccess: true })).totalDocs).toBe(1)
    const user = (await payload.find({ collection: 'users', where: { email: { equals: 'editor@example.test' } }, limit: 1, overrideAccess: true })).docs[0]!
    expect(user).toMatchObject({ provider: 'local', roles: ['editor'] })
    expect(user.emergencyTotpSecret).not.toContain(seed)
    expect(user.emergencyRecoveryHashes).toHaveLength(8)
    for (const code of completed.recoveryCodes ?? []) expect(JSON.stringify(user.emergencyRecoveryHashes)).not.toContain(code)
    expect(await payload.findByID({ collection: 'users', id: owner.id, overrideAccess: true })).toMatchObject({ id: existingOwner.id, emergencyTotpSecret: existingOwner.emergencyTotpSecret })
    const consumed = await payload.findByID({ collection: 'invitations', id: invitation.invitation.id, overrideAccess: true })
    expect(consumed.pendingTotpSecret).toBeNull()
    expect(JSON.stringify(await payload.find({ collection: 'audit-events', overrideAccess: true })).includes(seed)).toBe(false)
  })

  it('does not consume an invitation after a wrong proof and bounds retries', async () => {
    const invitation = await createUserInvitation(payload, owner, { email: 'retry@example.test', roles: ['sales'] })
    const token = tokenOf(invitation.inviteURL)
    const prepared = await POST(request({ action: 'prepare', token }))
    const seed = new URL((await prepared.json() as { otpauthURI: string }).otpauthURI).searchParams.get('secret')!
    const totp = new TOTP({ secret: seed, algorithm: 'SHA1', digits: 6, period: 30 })
    const valid = new Set([-1, 0, 1].map((window) => totp.generate({ timestamp: Date.now() + window * 30_000 })))
    let invalid = '000000'; while (valid.has(invalid)) invalid = String((Number(invalid) + 1) % 1_000_000).padStart(6, '0')
    for (let attempt = 0; attempt < 5; attempt++) expect((await POST(request({ action: 'confirm', token, code: invalid, name: 'Retry' }))).status).toBe(403)
    expect((await POST(request({ action: 'confirm', token, code: invalid, name: 'Retry' }))).status).toBe(429)
    expect((await payload.count({ collection: 'users', where: { email: { equals: 'retry@example.test' } }, overrideAccess: true })).totalDocs).toBe(0)
    const stillPrepared = await POST(request({ action: 'prepare', token }))
    expect(stillPrepared.status).toBe(200)
  })

  it('clears the pending seed when an Owner revokes an enrollment', async () => {
    const invitation = await createUserInvitation(payload, owner, { email: 'revoke@example.test', roles: ['hiring'] })
    const service = await import('../src/user-management')
    await service.revokeUserInvitation(payload, owner, invitation.invitation.id)
    const revoked = await payload.findByID({ collection: 'invitations', id: invitation.invitation.id, overrideAccess: true })
    expect(revoked.pendingTotpSecret).toBeNull()
  })

  it('rejects expired, revoked and consumed tokens, cross-origin requests, and oversized bodies without a user or session', async () => {
    const invitation = await createUserInvitation(payload, owner, { email: 'deny@example.test', roles: ['editor'] })
    const token = tokenOf(invitation.inviteURL)
    expect((await POST(new Request('https://cms.example.test/api/auth/enroll', { method: 'POST', headers: { origin: 'https://attacker.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'prepare', token }) }))).status).toBe(403)
    expect((await POST(request({ action: 'prepare', token, padding: 'x'.repeat(2050) }))).status).toBe(400)
    await payload.update({ collection: 'invitations', id: invitation.invitation.id, data: { expiresAt: new Date(Date.now() - 1).toISOString() }, overrideAccess: true })
    const expired = await POST(request({ action: 'prepare', token }))
    expect(expired.status).toBe(403)
    await payload.update({ collection: 'invitations', id: invitation.invitation.id, data: { expiresAt: new Date(Date.now() + 60_000).toISOString(), acceptedAt: new Date().toISOString() }, overrideAccess: true })
    const consumed = await POST(request({ action: 'prepare', token }))
    expect(consumed.status).toBe(403)
    expect((await payload.count({ collection: 'users', where: { email: { equals: 'deny@example.test' } }, overrideAccess: true })).totalDocs).toBe(0)
    expect((await payload.count({ collection: 'auth-sessions', overrideAccess: true })).totalDocs).toBe(0)
  })
})
