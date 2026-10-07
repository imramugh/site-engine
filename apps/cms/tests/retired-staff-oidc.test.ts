import { describe, expect, it } from 'vitest'

describe('retired staff OIDC routes', () => {
  it('does not redirect stale provider or callback links into external sign-in', async () => {
    const provider = await import('../app/api/auth/[provider]/route')
    const callback = await import('../app/api/auth/callback/[provider]/route')
    const [start, result] = await Promise.all([provider.GET(), callback.GET()])
    expect(start.status).toBe(410)
    expect(result.status).toBe(410)
    expect(start.headers.get('location')).toBeNull()
    expect(result.headers.get('location')).toBeNull()
  })
})
