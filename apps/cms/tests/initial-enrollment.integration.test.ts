import { describe, expect, it } from 'vitest'

describe('retired initial OIDC enrollment', () => {
  it('keeps the former provider endpoints unavailable', async () => {
    const start = await import('../app/api/auth/[provider]/route')
    const callback = await import('../app/api/auth/callback/[provider]/route')
    expect((await start.GET()).status).toBe(410)
    expect((await callback.GET()).status).toBe(410)
  })
})
