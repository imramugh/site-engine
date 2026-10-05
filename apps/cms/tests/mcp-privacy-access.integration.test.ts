import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPayload } from 'payload'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-mcp-privacy-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'mcp-privacy-access-test-secret-long-enough'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
const { default: config } = await import('../payload.config.js')
const route = await import('../app/api/mcp-privacy/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })
async function session(userID: string, fresh = true) { const token = newOpaqueToken(); const now = new Date(); await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: userID, authenticatedAt: new Date(now.getTime() - (fresh ? 0 : 20 * 60_000)).toISOString(), lastSeenAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() }, overrideAccess: true }); return `${cookieName(SESSION_COOKIE)}=${token}` }

test('MCP privacy policy is owner-only, CSRF guarded, strict, and audited', async () => {
  const sales = await payload.create({ collection: 'users', data: { name: 'Sales', email: 'sales-mcp-privacy@example.test', roles: ['sales'] }, overrideAccess: true })
  const owner = await payload.create({ collection: 'users', data: { name: 'Owner', email: 'owner-mcp-privacy@example.test', roles: ['owner'] }, overrideAccess: true })
  const salesCookie = await session(sales.id); const ownerCookie = await session(owner.id); const staleCookie = await session(owner.id, false)
  expect((await route.GET(new Request('http://cms.test/api/mcp-privacy', { headers: { cookie: salesCookie } }))).status).toBe(403)
  await expect((await route.GET(new Request('http://cms.test/api/mcp-privacy', { headers: { cookie: ownerCookie } }))).json()).resolves.toEqual({ hidePhone: true })
  const put = (cookie: string, origin: string, body: unknown) => route.PUT(new Request('http://cms.test/api/mcp-privacy', { method: 'PUT', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  expect((await put(ownerCookie, 'https://attacker.example', { hidePhone: false })).status).toBe(403)
  expect((await put(staleCookie, 'http://cms.test', { hidePhone: false })).status).toBe(403)
  expect((await put(ownerCookie, 'http://cms.test', { hidePhone: false, extra: true })).status).toBe(400)
  expect((await put(ownerCookie, 'http://cms.test', { hidePhone: false })).status).toBe(200)
  await expect((await route.GET(new Request('http://cms.test/api/mcp-privacy', { headers: { cookie: ownerCookie } }))).json()).resolves.toEqual({ hidePhone: false })
  const audits = await payload.find({ collection: 'audit-events', where: { event: { equals: 'mcp_privacy.updated' } }, overrideAccess: true })
  expect(audits.docs).toEqual(expect.arrayContaining([expect.objectContaining({ actor: expect.objectContaining({ id: owner.id }), detail: { hidePhone: false } })]))
  await expect(payload.find({ collection: 'mcp-privacy-settings', user: owner, overrideAccess: false })).rejects.toThrow('not allowed')
})
