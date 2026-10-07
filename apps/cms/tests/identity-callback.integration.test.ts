import { describe, expect, it } from 'vitest'

describe('retired staff OIDC callback', () => {
  it('returns a non-cacheable 410 without processing a provider response', async () => {
    const { GET } = await import('../app/api/auth/callback/[provider]/route')
    const response = await GET()
    expect(response.status).toBe(410)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('location')).toBeNull()
  })
})
