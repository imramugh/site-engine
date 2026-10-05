import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { getPayload } from 'payload'
import { cookieName, hashOpaqueToken, SESSION_COOKIE } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'connected-assistants-route-'))
Object.assign(process.env, { DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`, PAYLOAD_SECRET: 'connected-assistants-test-secret-long-enough', PAYLOAD_PUBLIC_SERVER_URL: 'http://cms.example.test', OAUTH_INTERNAL_ORIGIN: 'http://oauth.example.test', OAUTH_INTROSPECTION_SECRET: 'internal-secret' })
const { default: config } = await import('../payload.config.js'); const route = await import('../app/api/connected-assistants/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload.destroy(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); for (const key of ['OAUTH_INTERNAL_ORIGIN', 'OAUTH_INTROSPECTION_SECRET']) delete process.env[key] })
async function identity(role: 'owner' | 'editor', suffix: string, options: { disabled?: boolean; revoked?: boolean } = {}) { const user = await payload.create({ collection: 'users', data: { email: `${suffix}@example.test`, name: suffix, roles: [role], disabled: options.disabled }, overrideAccess: true }); const token = `token-${suffix}`; await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), ...(options.revoked ? { revokedAt: new Date().toISOString() } : {}) }, overrideAccess: true }); return { user, cookie: `${cookieName(SESSION_COOKIE)}=${token}` } }
const grant = (userId: string) => ({ managementId: '11111111-1111-4111-8111-111111111111', userId, clientId: 'must-not-reach-browser', clientName: 'Claude Desktop', resource: 'http://cms.example.test/mcp', scopes: ['mcp:content:read'], createdAt: Date.now() - 5_000, lastUsedAt: Date.now(), expiresAt: Date.now() + 60_000 })

test('Owner manages all assistant grants while staff can see and revoke only their own', async () => {
  const owner = await identity('owner', 'assistant-owner'); const editor = await identity('editor', 'assistant-editor'); const foreign = await identity('editor', 'assistant-foreign')
  const calls: Record<string, unknown>[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => { expect(new Headers(init?.headers).get('x-oauth-introspection-secret')).toBe('internal-secret'); const body = JSON.parse(String(init?.body)) as Record<string, unknown>; calls.push(body); if (body.operation === 'list') return Response.json({ grants: body.userId ? [grant(String(body.userId))] : [grant(String(editor.user.id)), grant(String(foreign.user.id))] }); return Response.json({ revoked: true }) })
  const ownerResponse = await route.GET(new Request('http://cms.example.test/api/connected-assistants', { headers: { cookie: owner.cookie } })); expect(ownerResponse.status).toBe(200); const ownerBody = await ownerResponse.json(); expect(ownerBody.scope).toBe('all'); expect(ownerBody.grants).toHaveLength(2); expect(JSON.stringify(ownerBody)).not.toContain('must-not-reach-browser'); expect(JSON.stringify(ownerBody)).not.toContain('internal-secret')
  const editorResponse = await route.GET(new Request('http://cms.example.test/api/connected-assistants', { headers: { cookie: editor.cookie } })); expect(editorResponse.status).toBe(200); const editorBody = await editorResponse.json(); expect(editorBody).toMatchObject({ scope: 'own', grants: [{ own: true, clientName: 'Claude Desktop' }] }); expect(calls.at(-1)).toEqual({ operation: 'list', userId: editor.user.id })
  expect((await route.POST(new Request('http://cms.example.test/api/connected-assistants', { method: 'POST', headers: { cookie: editor.cookie, origin: 'http://wrong.example.test' }, body: JSON.stringify({ action: 'revoke', managementId: grant('').managementId }) }))).status).toBe(403)
  const revoked = await route.POST(new Request('http://cms.example.test/api/connected-assistants', { method: 'POST', headers: { cookie: editor.cookie, origin: 'http://cms.example.test' }, body: JSON.stringify({ action: 'revoke', managementId: grant('').managementId }) })); expect(revoked.status).toBe(200); expect(calls.at(-1)).toEqual({ operation: 'revoke', managementId: grant('').managementId, userId: editor.user.id })
  const audit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'identity.assistant_revoked' } }, overrideAccess: true }); expect(audit.docs).toHaveLength(1); expect(audit.docs[0]?.detail).toEqual({ managementId: grant('').managementId, scope: 'own' });
  const ownerRevoked = await route.POST(new Request('http://cms.example.test/api/connected-assistants', { method: 'POST', headers: { cookie: owner.cookie, origin: 'http://cms.example.test' }, body: JSON.stringify({ action: 'revoke', managementId: grant('').managementId }) })); expect(ownerRevoked.status).toBe(200); expect(calls.at(-1)).toEqual({ operation: 'revoke', managementId: grant('').managementId })
})

test('disabled and revoked sessions cannot inspect assistant metadata', async () => {
  const disabled = await identity('editor', 'assistant-disabled', { disabled: true }); const revoked = await identity('editor', 'assistant-revoked', { revoked: true })
  expect((await route.GET(new Request('http://cms.example.test/api/connected-assistants', { headers: { cookie: disabled.cookie } }))).status).toBe(403)
  expect((await route.GET(new Request('http://cms.example.test/api/connected-assistants', { headers: { cookie: revoked.cookie } }))).status).toBe(403)
})
