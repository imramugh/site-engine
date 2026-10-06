import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPayload } from 'payload'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-mcp-write-checks-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.MEDIA_STORAGE_DIR = join(directory, 'media')
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-payload'
const { default: config } = await import('../payload.config.js')
const { handleMcp } = await import('../src/mcp.js')

type Token = { clientId: string; userId: string; sessionId: string; scopes: string[] }
const tokens = new Map<string, Token>()
let payload: Awaited<ReturnType<typeof getPayload>>
let origin = ''
let oauthServer: ReturnType<typeof createServer>

async function startServer(handler: (incoming: IncomingMessage, outgoing: ServerResponse) => Promise<void>) {
  const server = createServer((incoming, outgoing) => { void handler(incoming, outgoing) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}
async function sessionFor(user: string) { const now = new Date().toISOString(); return payload.create({ collection: 'auth-sessions', data: { tokenHash: `mcp-write-${crypto.randomUUID()}`, user, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 300_000).toISOString() }, overrideAccess: true }) }
async function call(token: string, name: string, arguments_: Record<string, unknown>, dependencies: Parameters<typeof handleMcp>[1] = {}) {
  const response = await handleMcp(new Request(`${origin}/mcp`, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name, arguments: arguments_ } }) }), dependencies)
  return { response, body: await response.json() as { result?: { structuredContent?: unknown; content?: Array<{ text?: string }> } } }
}
function result(body: { result?: { structuredContent?: unknown; content?: Array<{ text?: string }> } }) { const value = body.result?.structuredContent ?? body.result?.content?.find((item) => item.text)?.text; return typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : value as Record<string, unknown> }
function requiredString(value: Record<string, unknown>, field: string): string { const candidate = value[field]; if (typeof candidate !== 'string') throw new Error(`${field} must be a string`); return candidate }

beforeAll(async () => {
  payload = await getPayload({ config })
  const oauth = await startServer(async (incoming, outgoing) => { const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk)); const input = JSON.parse(Buffer.concat(chunks).toString()) as { token?: string; resource?: string }; const token = typeof input.token === 'string' ? tokens.get(input.token) : undefined; outgoing.writeHead(200, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify(token ? { active: true, clientId: token.clientId, userId: token.userId, sessionId: token.sessionId, scopes: token.scopes, resource: input.resource, expiresAt: Math.floor(Date.now() / 1000) + 300 } : { active: false })) })
  oauthServer = oauth.server; process.env.OAUTH_INTERNAL_ORIGIN = oauth.origin; process.env.OAUTH_INTROSPECTION_SECRET = 'mcp-write-secret'
  origin = 'http://cms.test'; process.env.PAYLOAD_PUBLIC_SERVER_URL = origin
})
afterAll(async () => { await payload?.destroy(); await new Promise<void>((resolve) => oauthServer.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); delete process.env.DATABASE_URI; delete process.env.MEDIA_STORAGE_DIR; delete process.env.PAYLOAD_SECRET; delete process.env.PAYLOAD_PUBLIC_SERVER_URL; delete process.env.OAUTH_INTERNAL_ORIGIN; delete process.env.OAUTH_INTROSPECTION_SECRET })

test('section and page writes persist captures and return evaluated draft envelopes', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: 'mcp-write-checks@example.test', name: 'MCP write checks', roles: ['editor'] }, overrideAccess: true })
  const session = await sessionFor(editor.id); tokens.set('writes', { clientId: 'write-checks-client', userId: editor.id, sessionId: session.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  const set = result((await call('writes', 'create_change_set', { name: 'MCP checked writes' })).body)
  const setID = requiredString(set, 'id')
  const createdSection = result((await call('writes', 'create_section', { changeSetId: set.id, expectedChangeSetRevision: set.revision, requestKey: crypto.randomUUID(), name: 'Checked section', slug: `checked-${crypto.randomUUID().slice(0, 8)}`, allowedTemplates: ['standard'] })).body)
  expect(createdSection).toMatchObject({ id: expect.any(String), changeSetId: set.id, changeSetRevision: 1, checks: expect.any(Array), warnings: expect.any(Array), readiness: expect.anything() })
  const updatedSection = result((await call('writes', 'update_section', { id: createdSection.id, changeSetId: set.id, expectedChangeSetRevision: createdSection.changeSetRevision, name: 'Checked section revised' })).body)
  expect(updatedSection).toMatchObject({ id: createdSection.id, changeSetRevision: 2, checks: expect.any(Array) })
  const page = result((await call('writes', 'create_page', { changeSetId: set.id, expectedChangeSetRevision: updatedSection.changeSetRevision, requestKey: crypto.randomUUID(), title: 'Checked draft page', summary: 'A sufficiently long summary for a page that returns evaluated checks.', slug: `checked-page-${crypto.randomUUID().slice(0, 8)}`, sectionId: createdSection.id, template: 'standard' })).body)
  expect(page).toMatchObject({ id: expect.any(String), changeSetId: set.id, changeSetRevision: 3, checks: expect.any(Array), warnings: expect.any(Array), readiness: expect.anything() })
  const recipe = result((await call('writes', 'create_page_from_recipe', { changeSetId: set.id, expectedChangeSetRevision: page.changeSetRevision, requestKey: crypto.randomUUID(), title: 'Checked recipe page', summary: 'A sufficiently long summary for a recipe page that returns evaluated checks.', slug: `checked-recipe-${crypto.randomUUID().slice(0, 8)}`, sectionId: createdSection.id, template: 'standard', blocks: [{ type: 'faq' }] })).body)
  expect(recipe).toMatchObject({ changeSetRevision: 4, checks: expect.any(Array), blocks: [expect.objectContaining({ type: 'faq' })] })
  expect((await payload.findByID({ collection: 'change-sets', id: setID, overrideAccess: true }) as { changes: unknown[] }).changes).toHaveLength(3)
})

test('an evaluator failure rolls back the page and its captured change', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: 'mcp-write-rollback@example.test', name: 'MCP write rollback', roles: ['editor'] }, overrideAccess: true })
  const session = await sessionFor(editor.id); tokens.set('rollback-writes', { clientId: 'write-rollback-client', userId: editor.id, sessionId: session.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  const section = await payload.create({ collection: 'sections', data: { name: 'Rollback section', slug: `rollback-${crypto.randomUUID().slice(0, 8)}`, allowedTemplates: ['standard'] }, user: editor, overrideAccess: false })
  const set = result((await call('rollback-writes', 'create_change_set', { name: 'Rollback checked write' })).body)
  const setID = requiredString(set, 'id')
  const beforePages = await payload.count({ collection: 'pages', overrideAccess: true })
  const failed = await call('rollback-writes', 'create_page', { changeSetId: set.id, expectedChangeSetRevision: set.revision, requestKey: crypto.randomUUID(), title: 'Must roll back', summary: 'A sufficiently long summary for the evaluator rollback behavior test.', slug: `rollback-page-${crypto.randomUUID().slice(0, 8)}`, sectionId: section.id, template: 'standard' }, { evaluateChangeSetQuality: async () => { throw new Error('injected quality fault') } })
  expect(result(failed.body)).toEqual({ error: 'write_failed' })
  expect((await payload.count({ collection: 'pages', overrideAccess: true })).totalDocs).toBe(beforePages.totalDocs)
  expect((await payload.findByID({ collection: 'change-sets', id: setID, overrideAccess: true }) as { changes: unknown[] }).changes).toEqual([])
})
