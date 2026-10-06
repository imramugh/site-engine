import { describe, expect, it } from 'vitest'
import { hasRole } from '../src/access.js'
import { isRetryableSQLiteError, sqliteBackpressureResponse } from '../src/sqlite.js'
import { hasFreshAuthentication, SESSION_IDLE_SECONDS, sessionIsUsable } from '../src/identity'
import { decryptSecret, encryptSecret, recoveryHash, recoveryMatches } from '../src/totp'

const { default: configPromise } = await import('../payload.config.js')
const config = await configPromise

describe('role matrix (ENG-007)', () => {
  it('allows only matching active roles', () => {
    expect(hasRole({ roles: ['editor'] }, ['editor', 'owner'])).toBe(true)
    expect(hasRole({ roles: ['editor'] }, ['owner'])).toBe(false)
    expect(hasRole({ roles: ['owner'], disabled: true }, ['owner'])).toBe(false)
  })

  it('classifies SQLite lock backpressure as retryable (ENG-036)', () => {
    expect(isRetryableSQLiteError(new Error('SQLITE_BUSY: database is locked'))).toBe(true)
    expect(isRetryableSQLiteError({ code: 'SQLITE_BUSY' })).toBe(true)
    expect(isRetryableSQLiteError(new Error('validation failed'))).toBe(false)
  })

  it('returns a stable retry response for custom and native Payload routes (ENG-036)', async () => {
    const driverError = new Error('SQLITE_BUSY: database is locked: internal path')
    const custom = sqliteBackpressureResponse(driverError, { error: 'safe' })!
    expect(custom.status).toBe(503)
    expect(custom.headers.get('Retry-After')).toBe('1')
    expect(await custom.json()).toEqual({ error: 'safe' })

    const responseHeaders = new Headers()
    const nativePayloadErrorHook = config.hooks?.afterError?.[0]
    expect(nativePayloadErrorHook).toBeDefined()
    expect(await nativePayloadErrorHook!({ error: driverError, req: { responseHeaders } } as never)).toEqual({ status: 503, response: { errors: [{ message: 'Saving is temporarily busy. Please retry.' }] } })
    expect(responseHeaders.get('Retry-After')).toBe('1')
    expect(await nativePayloadErrorHook!({ error: new Error('validation failed'), req: { responseHeaders } } as never)).toBeUndefined()
  })

  it('enforces eight-hour idle and fifteen-minute sensitive-session policy (ENG-007)', () => {
    const now = Date.now()
    expect(sessionIsUsable({ expiresAt: new Date(now + 60_000).toISOString(), lastSeenAt: new Date(now - (SESSION_IDLE_SECONDS * 1000) - 1).toISOString() }, now)).toBe(false)
    expect(hasFreshAuthentication({ authenticatedAt: new Date(now - (15 * 60 * 1000) - 1).toISOString() }, now)).toBe(false)
  })

  it('encrypts TOTP material and accepts a recovery code only by its stored hash (ENG-007)', () => {
    process.env.EMERGENCY_TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64url')
    expect(decryptSecret(encryptSecret('BASE32SECRET'))).toBe('BASE32SECRET')
    const hash = recoveryHash('one-time-code')
    expect(recoveryMatches('one-time-code', hash)).toBe(true)
    expect(recoveryMatches('wrong-code', hash)).toBe(false)
  })
})
