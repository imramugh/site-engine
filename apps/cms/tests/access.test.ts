import { describe, expect, it } from 'vitest'
import { hasRole } from '../src/access.js'
import { isRetryableSQLiteError } from '../src/sqlite.js'

describe('role matrix (ENG-007)', () => {
  it('allows only matching active roles', () => {
    expect(hasRole({ roles: ['editor'] }, ['editor', 'owner'])).toBe(true)
    expect(hasRole({ roles: ['editor'] }, ['owner'])).toBe(false)
    expect(hasRole({ roles: ['owner'], disabled: true }, ['owner'])).toBe(false)
  })

  it('classifies SQLite lock backpressure as retryable (ENG-036)', () => {
    expect(isRetryableSQLiteError(new Error('SQLITE_BUSY: database is locked'))).toBe(true)
    expect(isRetryableSQLiteError(new Error('validation failed'))).toBe(false)
  })
})
