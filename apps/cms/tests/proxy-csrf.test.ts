import { afterEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '../proxy'

const origin = 'https://cms.example.test'

afterEach(() => { delete process.env.PAYLOAD_PUBLIC_SERVER_URL })

function post(path: string) {
  return proxy(new NextRequest(`${origin}${path}`, { method: 'POST' }))
}

describe('internal worker CSRF proxy boundary', () => {
  it('exempts only the exact mailbox worker POST route for its bearer handler', () => {
    process.env.PAYLOAD_PUBLIC_SERVER_URL = origin
    expect(post('/api/internal/mailbox-worker/run').headers.get('x-middleware-next')).toBe('1')
    for (const path of ['/api/internal/mailbox-worker/run/other', '/api/internal/mailbox-worker/other', '/api/internal/other']) {
      expect(post(path)).toMatchObject({ status: 403 })
    }
  })
})
