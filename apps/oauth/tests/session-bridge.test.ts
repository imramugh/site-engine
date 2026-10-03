import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { test } from 'vitest'
import { createHttpSessionBridge } from '../src/session-bridge.js'

function incoming(cookie?: string): IncomingMessage {
  const request = new EventEmitter() as IncomingMessage
  Object.assign(request, { headers: cookie ? { cookie } : {} })
  return request
}

test('HTTP CMS bridge sends only the CMS session cookie and accepts the exact minimal response', async () => {
  let received: { url?: string; headers?: Headers; body?: string; redirect?: RequestRedirect } = {}
  const bridge = createHttpSessionBridge({
    cmsOrigin: 'http://cms.test:3001', secret: 'shared-secret',
    fetch: async (url, init) => {
      received = { url: String(url), headers: new Headers(init?.headers), body: String(init?.body), redirect: init?.redirect }
      return Response.json({ user: { id: 'user-1', sessionId: 'session-1', scopes: ['mcp:content:read'] } })
    },
  })
  assert.deepEqual(await bridge.resolve(incoming('unrelated=value; site_engine_session=opaque-session; another=other')), {
    id: 'user-1', sessionId: 'session-1', enabled: true, scopes: ['mcp:content:read'],
  })
  assert.equal(received.url, 'http://cms.test:3001/api/internal/oauth/session')
  assert.equal(received.headers?.get('cookie'), 'site_engine_session=opaque-session')
  assert.equal(received.headers?.get('x-oauth-bridge-secret'), 'shared-secret')
  assert.equal(received.redirect, 'error')
  assert.deepEqual(JSON.parse(received.body ?? ''), { operation: 'resolve' })
  assert.deepEqual(await bridge.find('user-1', 'session-1'), {
    id: 'user-1', sessionId: 'session-1', enabled: true, scopes: ['mcp:content:read'],
  })
  assert.deepEqual(JSON.parse(received.body ?? ''), { operation: 'validate', userId: 'user-1', sessionId: 'session-1' })
})

test('HTTP CMS bridge rejects unsafe origins, redirects, and non-JSON responses', async () => {
  for (const cmsOrigin of ['http://user:pass@cms.test', 'http://cms.test/private', 'http://cms.test/?query=yes', 'http://cms.test/#fragment']) {
    const bridge = createHttpSessionBridge({ cmsOrigin, secret: 'shared-secret', fetch: async () => { throw new Error('must not fetch') } })
    assert.equal(await bridge.resolve(incoming('site_engine_session=opaque-session')), undefined)
  }
  let redirect: RequestRedirect | undefined
  const bridge = createHttpSessionBridge({
    cmsOrigin: 'http://cms.test', secret: 'shared-secret',
    fetch: async (_url, init) => { redirect = init?.redirect; return new Response('not-json', { headers: { 'content-type': 'text/plain' } }) },
  })
  assert.equal(await bridge.resolve(incoming('site_engine_session=opaque-session')), undefined)
  assert.equal(redirect, 'error')
})

test('HTTP CMS bridge cancels oversized chunked responses and fails closed on backend errors', async () => {
  let cancelled = false
  const oversized = createHttpSessionBridge({
    cmsOrigin: 'http://cms.test', secret: 'shared-secret',
    fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4_097)); },
      cancel() { cancelled = true },
    }), { headers: { 'content-type': 'application/json' } }),
  })
  assert.equal(await oversized.resolve(incoming('site_engine_session=opaque-session')), undefined)
  assert.equal(cancelled, true)
  const unavailable = createHttpSessionBridge({ cmsOrigin: 'http://cms.test', secret: 'shared-secret', fetch: async () => new Response(null, { status: 503, headers: { 'content-type': 'application/json' } }) })
  assert.equal(await unavailable.resolve(incoming('site_engine_session=opaque-session')), undefined)
})

test('HTTP CMS bridge fails closed for malformed responses and timeouts', async () => {
  const malformed = createHttpSessionBridge({
    cmsOrigin: 'http://cms.test', secret: 'shared-secret', fetch: async () => Response.json({ user: { id: 'user-1', sessionId: 'session-1', scopes: [], email: 'never-accepted@example.test' } }),
  })
  assert.equal(await malformed.resolve(incoming('site_engine_session=opaque-session')), undefined)

  const timeout = createHttpSessionBridge({
    cmsOrigin: 'http://cms.test', secret: 'shared-secret', timeoutMs: 5,
    fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  assert.equal(await timeout.resolve(incoming('site_engine_session=opaque-session')), undefined)
  assert.equal(await timeout.find('user-1'), undefined)
})
