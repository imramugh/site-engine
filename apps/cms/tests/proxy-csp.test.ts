import { afterEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '../proxy'

const origin = 'https://cms.example.test'
const environment = process.env as { NODE_ENV?: string }
const nodeEnvironment = environment.NODE_ENV

afterEach(() => { environment.NODE_ENV = nodeEnvironment })

function document(path: string) {
  return proxy(new NextRequest(`${origin}${path}`))
}

function nonce(policy: string): string {
  const match = /'nonce-([^']+)'/.exec(policy)
  if (!match) throw new Error('CSP nonce missing')
  return match[1]
}

describe('CMS document CSP proxy boundary', () => {
  it('protects staff and Payload admin documents with a fresh production nonce', () => {
    environment.NODE_ENV = 'production'
    const first = document('/admin/login')
    const second = document('/review/11111111-1111-4111-8111-111111111111')
    const firstPolicy = first.headers.get('content-security-policy')
    const secondPolicy = second.headers.get('content-security-policy')
    expect(firstPolicy).toBeTruthy()
    expect(secondPolicy).toBeTruthy()
    expect(nonce(firstPolicy!)).not.toBe(nonce(secondPolicy!))
    for (const directive of [
      "default-src 'self'", "base-uri 'none'", "object-src 'none'", "connect-src 'self'",
      "img-src 'self' data: blob:", "font-src 'self' data:", "media-src 'self'", "frame-src 'self'",
      "frame-ancestors 'none'", "form-action 'self'", 'report-uri /__csp/report', "script-src 'self' 'nonce-",
    ]) expect(firstPolicy).toContain(directive)
    expect(firstPolicy).not.toContain("script-src 'unsafe-inline'")
    expect(firstPolicy).not.toContain("'unsafe-eval'")
    expect(first.headers.get('cache-control')).toBe('no-store')
    expect(first.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(first.headers.get('x-content-type-options')).toBe('nosniff')
    // Next forwards these headers to its renderer, which applies the nonce to
    // framework hydration scripts.
    expect(first.headers.get('x-middleware-request-x-nonce')).toBe(nonce(firstPolicy!))
    expect(first.headers.get('x-middleware-request-content-security-policy')).toBe(firstPolicy)
  })

  it('keeps APIs and static framework assets out of the generic document policy', () => {
    environment.NODE_ENV = 'production'
    for (const path of ['/api/health', '/_next/static/chunks/app.js']) {
      const response = document(path)
      expect(response.headers.get('content-security-policy')).toBeNull()
      expect(response.headers.get('cache-control')).not.toBe('no-store')
    }
  })

  it('allows eval only while developing', () => {
    environment.NODE_ENV = 'development'
    expect(document('/admin/login').headers.get('content-security-policy')).toContain("'unsafe-eval'")
  })
})
