import { afterEach, expect, test } from 'vitest'
import { handleMcp } from '../src/mcp'

const saved = { origin: process.env.PAYLOAD_PUBLIC_SERVER_URL, oauth: process.env.OAUTH_INTERNAL_ORIGIN, secret: process.env.OAUTH_INTROSPECTION_SECRET }
afterEach(() => {
  if (saved.origin === undefined) delete process.env.PAYLOAD_PUBLIC_SERVER_URL; else process.env.PAYLOAD_PUBLIC_SERVER_URL = saved.origin
  if (saved.oauth === undefined) delete process.env.OAUTH_INTERNAL_ORIGIN; else process.env.OAUTH_INTERNAL_ORIGIN = saved.oauth
  if (saved.secret === undefined) delete process.env.OAUTH_INTROSPECTION_SECRET; else process.env.OAUTH_INTROSPECTION_SECRET = saved.secret
})

test('MCP rejects cookies, anonymous requests, unsupported methods, and unavailable introspection', async () => {
  process.env.PAYLOAD_PUBLIC_SERVER_URL = 'https://cms.example.test'
  expect((await handleMcp(new Request('https://attacker.example/mcp', { method: 'GET' }))).status).toBe(405)
  const anonymous = await handleMcp(new Request('https://attacker.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'site_engine_session=never-a-bearer' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) }))
  expect(anonymous.status).toBe(401)
  expect(anonymous.headers.get('www-authenticate')).toContain('https://cms.example.test/.well-known/oauth-protected-resource/mcp')
  process.env.OAUTH_INTERNAL_ORIGIN = 'http://127.0.0.1:1'; process.env.OAUTH_INTROSPECTION_SECRET = 'unavailable'
  expect((await handleMcp(new Request('https://cms.example.test/mcp', { method: 'POST', headers: { authorization: 'Bearer opaque', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) }))).status).toBe(401)
})
