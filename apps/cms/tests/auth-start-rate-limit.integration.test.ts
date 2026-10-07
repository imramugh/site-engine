import { describe, expect, it } from 'vitest'

describe('retired staff OIDC start route', () => {
  it('does not create a transaction or redirect to a configured external provider', async () => {
    const { GET } = await import('../app/api/auth/[provider]/route')
    const response = await GET()
    expect(response.status).toBe(410)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})
