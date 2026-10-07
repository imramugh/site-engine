import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { TOTP } from 'otpauth'
import { getPayload } from 'payload'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-emergency-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-only-payload-secret-emergency-integration'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'https://cms.example.test'
process.env.EMERGENCY_TOTP_ENCRYPTION_KEY = randomBytes(32).toString('base64url')
const { default: config } = await import('../payload.config')
const { POST } = await import('../app/api/auth/emergency/route')
const { encryptSecret, recoveryHash, acceptedTOTPCounter } = await import('../src/totp')
const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
let payload: Awaited<ReturnType<typeof getPayload>>
let userID: string
const request = (code: string, origin = 'https://cms.example.test') => new Request('https://cms.example.test/api/auth/emergency', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.test', code }) })

beforeAll(async () => {
  payload = await getPayload({ config })
  const user = await payload.create({ collection: 'users', data: { email: 'owner@example.test', name: 'Test Owner', roles: ['owner'], emergencyTotpSecret: encryptSecret(secret), emergencyRecoveryHashes: [recoveryHash('one-time-recovery')] }, overrideAccess: true })
  userID = user.id
})
afterAll(async () => { vi.restoreAllMocks(); await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

describe('ENG-007 emergency authentication through HTTP requests and real SQLite', () => {
  it('signs in every enabled role with a local authenticator', async () => {
    for (const role of ['owner', 'approver', 'editor', 'sales', 'hiring'] as const) {
      const user = await payload.create({ collection: 'users', data: { email: `${role}-local@example.test`, name: role, roles: [role], emergencyTotpSecret: encryptSecret(secret), emergencyRecoveryHashes: [recoveryHash(`${role}-recovery`)] }, overrideAccess: true })
      const response = await POST(new Request('https://cms.example.test/api/auth/local', { method: 'POST', headers: { origin: 'https://cms.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, code: `${role}-recovery` }) }))
      expect(response.status).toBe(200)
      expect(response.headers.get('set-cookie')).toContain('site_engine_session')
    }
  })
  it('rejects cross-origin credentials without creating a session', async () => {
    expect((await POST(request('one-time-recovery', 'https://attacker.example.test'))).status).toBe(403)
    expect((await payload.count({ collection: 'auth-sessions', overrideAccess: true })).totalDocs).toBe(5)
  })
  it('consumes a recovery credential once, even when submitted concurrently', async () => {
    const results = await Promise.all([POST(request('one-time-recovery')), POST(request('one-time-recovery'))])
    expect(results.filter((response) => response.status === 200)).toHaveLength(1)
    expect((await payload.count({ collection: 'auth-sessions', overrideAccess: true })).totalDocs).toBe(6)
    const user = await payload.findByID({ collection: 'users', id: userID, overrideAccess: true })
    expect(user.emergencyRecoveryHashes).toEqual([])
  })
  it('records the accepted future TOTP counter and rejects it in the next time slot', async () => {
    const now = Date.now()
    const future = new TOTP({ secret, algorithm: 'SHA1', digits: 6, period: 30 }).generate({ timestamp: now + 30_000 })
    expect(acceptedTOTPCounter(secret, future, now)).toBe(Math.floor(now / 30_000) + 1)
    expect((await POST(request(future))).status).toBe(200)
    const stored = await payload.findByID({ collection: 'users', id: userID, overrideAccess: true })
    expect(stored.emergencyLastCounter).toBe(Math.floor(now / 30_000) + 1)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 30_000)
    try { expect((await POST(request(future))).status).toBe(403) } finally { clock.mockRestore() }
  })
  it('audits accepted and denied decisions with fixed private-safe metadata', async () => {
    const events = await payload.find({ collection: 'audit-events', where: { user: { equals: userID } }, limit: 20, depth: 0, overrideAccess: true })
    const serialized = JSON.stringify(events.docs)
    expect(events.docs.some((event: any) => event.event === 'identity.local_signed_in' && event.detail?.provider === 'local')).toBe(true)
    expect(serialized).not.toContain('one-time-recovery')
    expect(serialized).not.toContain('owner@example.test')
  })

  it('locks repeated invalid attempts and records bounded account-state denials', async () => {
    await payload.update({ collection: 'users', id: userID, data: { emergencyFailedCount: 0, emergencyFailedAt: null }, overrideAccess: true })
    const beforeInvalid = await payload.count({ collection: 'audit-events', where: { and: [{ event: { equals: 'identity.local_denied' } }, { 'detail.reason': { equals: 'invalid_credential' } }] }, overrideAccess: true })
    for (let i = 0; i < 5; i++) expect((await POST(request('invalid-recovery'))).status).toBe(403)
    expect((await POST(request('invalid-recovery'))).status).toBe(429)
    const invalidAudits = await payload.find({ collection: 'audit-events', where: { and: [{ event: { equals: 'identity.local_denied' } }, { 'detail.reason': { equals: 'invalid_credential' } }] }, limit: 20, depth: 0, overrideAccess: true })
    expect(invalidAudits.docs).toHaveLength(beforeInvalid.totalDocs + 5)
    expect(invalidAudits.docs.every((event: any) => event.detail?.provider === 'local')).toBe(true)
    // Disabling staff must preserve another active Owner.
    await payload.create({ collection: 'users', data: { email: 'retained-owner@example.test', name: 'Retained Owner', roles: ['owner'] }, overrideAccess: true })
    await payload.update({ collection: 'users', id: userID, data: { disabled: true }, overrideAccess: true })
    expect((await POST(request('invalid-recovery'))).status).toBe(403)
    expect((await POST(request('invalid-recovery'))).status).toBe(403)
    const disabledAudits = await payload.find({ collection: 'audit-events', where: { and: [{ event: { equals: 'identity.emergency_denied' } }, { 'detail.reason': { equals: 'account_disabled' } }] }, limit: 20, depth: 0, overrideAccess: true })
    expect(disabledAudits.docs).toHaveLength(1)
    expect(JSON.stringify(disabledAudits.docs[0])).not.toContain('invalid-recovery')
  })
})
