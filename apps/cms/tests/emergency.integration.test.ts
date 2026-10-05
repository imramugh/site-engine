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
  it('rejects cross-origin credentials without creating a session', async () => {
    expect((await POST(request('one-time-recovery', 'https://attacker.example.test'))).status).toBe(403)
    expect((await payload.count({ collection: 'auth-sessions', overrideAccess: true })).totalDocs).toBe(0)
  })
  it('consumes a recovery credential once, even when submitted concurrently', async () => {
    const results = await Promise.all([POST(request('one-time-recovery')), POST(request('one-time-recovery'))])
    expect(results.filter((response) => response.status === 200)).toHaveLength(1)
    expect((await payload.count({ collection: 'auth-sessions', overrideAccess: true })).totalDocs).toBe(1)
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
  it('locks repeated invalid attempts and rejects disabled owners', async () => {
    await payload.update({ collection: 'users', id: userID, data: { emergencyFailedCount: 0, emergencyFailedAt: null }, overrideAccess: true })
    for (let i = 0; i < 5; i++) expect((await POST(request('invalid-recovery'))).status).toBe(403)
    expect((await POST(request('invalid-recovery'))).status).toBe(429)
    // Disabling staff must preserve another active Owner.
    await payload.create({ collection: 'users', data: { email: 'retained-owner@example.test', name: 'Retained Owner', roles: ['owner'] }, overrideAccess: true })
    await payload.update({ collection: 'users', id: userID, data: { disabled: true }, overrideAccess: true })
    expect((await POST(request('invalid-recovery'))).status).toBe(403)
  })
})
