import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { getPayload } from 'payload'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-mcp-audit-'))
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

async function sessionFor(user: string) {
  const now = new Date().toISOString()
  return payload.create({ collection: 'auth-sessions', data: { tokenHash: `mcp-audit-${crypto.randomUUID()}`, user, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 300_000).toISOString() }, overrideAccess: true })
}

async function call(token: string, method: string, params: Record<string, unknown>, id = 1) {
  return handleMcp(new Request(`${origin}/mcp`, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }))
}

async function events(event: string) {
  return (await payload.find({ collection: 'audit-events', where: { event: { equals: event } }, sort: '-createdAt', limit: 100, overrideAccess: true })).docs
}

beforeAll(async () => {
  payload = await getPayload({ config })
  const oauth = await startServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const input = JSON.parse(Buffer.concat(chunks).toString()) as { token?: string; resource?: string }
    const token = typeof input.token === 'string' ? tokens.get(input.token) : undefined
    const response = token ? { active: true, clientId: token.clientId, userId: token.userId, sessionId: token.sessionId, scopes: token.scopes, resource: input.resource, expiresAt: Math.floor(Date.now() / 1000) + 300 } : { active: false }
    outgoing.writeHead(200, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify(response))
  })
  oauthServer = oauth.server
  process.env.OAUTH_INTERNAL_ORIGIN = oauth.origin
  process.env.OAUTH_INTROSPECTION_SECRET = 'mcp-audit-secret'
  origin = 'http://cms.test'
  process.env.PAYLOAD_PUBLIC_SERVER_URL = origin
})

afterAll(async () => {
  await payload?.destroy(); await new Promise<void>((resolve) => oauthServer.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
  delete process.env.DATABASE_URI; delete process.env.MEDIA_STORAGE_DIR; delete process.env.PAYLOAD_SECRET; delete process.env.PAYLOAD_PUBLIC_SERVER_URL; delete process.env.OAUTH_INTERNAL_ORIGIN; delete process.env.OAUTH_INTROSPECTION_SECRET
})

test('MCP invocation audit records safe correlated starts and terminal outcomes', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: 'mcp-audit-editor@example.test', name: 'MCP audit editor', roles: ['editor'] }, overrideAccess: true })
  const disabled = await payload.create({ collection: 'users', data: { email: 'mcp-audit-disabled@example.test', name: 'Disabled audit user', roles: ['editor'], disabled: true }, overrideAccess: true })
  const [editorSession, disabledSession] = await Promise.all([sessionFor(editor.id), sessionFor(disabled.id)])
  tokens.set('audit-read', { clientId: 'audit-read-client', userId: editor.id, sessionId: editorSession.id, scopes: ['mcp:content:read'] })
  tokens.set('audit-write', { clientId: 'audit-write-client', userId: editor.id, sessionId: editorSession.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  tokens.set('audit-none', { clientId: 'audit-none-client', userId: editor.id, sessionId: editorSession.id, scopes: [] })
  tokens.set('audit-missing-session', { clientId: 'audit-missing-session-client', userId: editor.id, sessionId: crypto.randomUUID(), scopes: ['mcp:content:read'] })
  tokens.set('audit-missing-user', { clientId: 'audit-missing-user-client', userId: crypto.randomUUID(), sessionId: editorSession.id, scopes: ['mcp:content:read'] })
  tokens.set('audit-disabled', { clientId: 'audit-disabled-client', userId: disabled.id, sessionId: disabledSession.id, scopes: ['mcp:content:read'] })

  expect((await call('audit-read', 'tools/call', { name: 'get_block_library', arguments: {} })).status).toBe(200)
  expect((await call('audit-write', 'tools/call', { name: 'create_change_set', arguments: { name: 'Audit-safe write' } }, 2)).status).toBe(200)
  expect((await call('audit-read', 'tools/call', { name: 'get_page', arguments: { id: crypto.randomUUID() } }, 3)).status).toBe(200)
  expect((await call('audit-read', 'tools/call', { name: 'untrusted-secret-tool-name', arguments: { content: 'must not be audited', nested: { id: 'credential-must-not-be-a-reference' } } }, 4)).status).toBe(200)
  expect((await call('audit-none', 'tools/call', { name: 'get_page', arguments: { id: crypto.randomUUID() } }, 5)).status).toBe(403)
  expect((await call('audit-read', 'tools/call', { name: 'get_page', arguments: { id: crypto.randomUUID(), overrideAccess: true } }, 6)).status).toBe(400)
  expect((await call('audit-missing-session', 'tools/call', { name: 'get_block_library', arguments: {} }, 7)).status).toBe(401)
  expect((await call('audit-missing-user', 'tools/call', { name: 'get_block_library', arguments: {} }, 71)).status).toBe(401)
  expect((await call('audit-disabled', 'tools/call', { name: 'get_block_library', arguments: {} }, 8)).status).toBe(401)

  const starts = await events('mcp.request') as Array<{ user?: unknown; actor?: unknown; detail?: Record<string, unknown> }>
  const results = await events('mcp.result') as Array<{ detail?: Record<string, unknown> }>
  const auditStarts = starts.filter((row) => row.detail?.clientIdHash && row.detail?.state === 'started')
  expect(auditStarts).toHaveLength(6)
  const relationID = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? value.id : undefined
  expect(auditStarts.map((row) => relationID(row.user))).toEqual(expect.arrayContaining([editor.id]))
  expect(auditStarts.every((row) => relationID(row.user) === editor.id && relationID(row.actor) === editor.id)).toBe(true)
  expect(auditStarts.every((row) => Array.isArray(row.detail?.scopes))).toBe(true)
  expect(auditStarts.some((row) => row.detail?.tool === 'unknown')).toBe(true)
  expect(JSON.stringify(auditStarts)).not.toContain('untrusted-secret-tool-name')
  expect(JSON.stringify(auditStarts)).not.toContain('must not be audited')
  expect(JSON.stringify(auditStarts)).not.toContain('credential-must-not-be-a-reference')
  expect(results.map((row) => row.detail?.result)).toEqual(expect.arrayContaining(['success', 'tool_error', 'schema_error', 'unknown', 'denied']))
  const startIDs = new Set(auditStarts.map((row) => row.detail?.invocationId))
  expect(results.filter((row) => startIDs.has(row.detail?.invocationId))).toHaveLength(6)
  expect(results.some((row) => row.detail?.tool === 'create_change_set' && typeof (row.detail?.references as Record<string, unknown> | undefined)?.id === 'string')).toBe(true)
})

test('strict registration rejects an unknown create_page key before it captures a draft', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: 'mcp-audit-strict@example.test', name: 'MCP strict editor', roles: ['editor'] }, overrideAccess: true })
  const session = await sessionFor(editor.id)
  tokens.set('audit-strict', { clientId: 'audit-strict-client', userId: editor.id, sessionId: session.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  const beforePages = await payload.count({ collection: 'pages', overrideAccess: true })
  const beforeChanges = await payload.count({ collection: 'change-sets', overrideAccess: true })
  const response = await call('audit-strict', 'tools/call', { name: 'create_page', arguments: { changeSetId: crypto.randomUUID(), expectedChangeSetRevision: 0, requestKey: crypto.randomUUID(), sectionId: crypto.randomUUID(), title: 'Valid except for its unknown key', summary: 'This otherwise valid synthetic page request proves strict schema rejection occurs first.', slug: `strict-${crypto.randomUUID().slice(0, 8)}`, template: 'standard', unexpected: 'must not reach capture' } }, 20)
  expect(response.status).toBe(200)
  expect((await response.text()).toLowerCase()).toMatch(/unrecognized|invalid|validation/)
  expect((await payload.count({ collection: 'pages', overrideAccess: true })).totalDocs).toBe(beforePages.totalDocs)
  expect((await payload.count({ collection: 'change-sets', overrideAccess: true })).totalDocs).toBe(beforeChanges.totalDocs)
})

test('a result-audit failure reports an uncertain completed mutation without replaying it', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: 'mcp-audit-failure@example.test', name: 'MCP audit failure editor', roles: ['editor'] }, overrideAccess: true })
  const session = await sessionFor(editor.id)
  tokens.set('audit-result-failure', { clientId: 'audit-result-failure-client', userId: editor.id, sessionId: session.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  const before = await payload.count({ collection: 'change-sets', overrideAccess: true })
  const originalCreate = payload.create.bind(payload)
  let armed = true
  ;(payload as unknown as { create: typeof payload.create }).create = (async (input: Parameters<typeof payload.create>[0]) => {
    if (armed && input.collection === 'audit-events' && (input.data as { event?: unknown }).event === 'mcp.result') { armed = false; throw new Error('audit storage unavailable') }
    return originalCreate(input)
  }) as typeof payload.create
  try {
    const response = await call('audit-result-failure', 'tools/call', { name: 'create_change_set', arguments: { name: 'Only once despite audit failure' } })
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: 'audit_recording_failed', operationMayHaveCompleted: true })
  } finally { ;(payload as unknown as { create: typeof payload.create }).create = originalCreate as typeof payload.create }
  expect((await payload.count({ collection: 'change-sets', overrideAccess: true })).totalDocs).toBe(before.totalDocs + 1)
})

test('a transport dispatch failure records an unknown terminal outcome without retrying', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: 'mcp-audit-dispatch@example.test', name: 'MCP audit dispatch', roles: ['editor'] }, overrideAccess: true })
  const session = await sessionFor(editor.id)
  tokens.set('audit-dispatch-failure', { clientId: 'audit-dispatch-failure-client', userId: editor.id, sessionId: session.id, scopes: ['mcp:content:read'] })
  const spy = vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, 'handleRequest').mockRejectedValueOnce(new Error('injected transport failure'))
  try {
    const response = await call('audit-dispatch-failure', 'tools/call', { name: 'get_block_library', arguments: {} })
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: 'dispatch_outcome_unknown', operationMayHaveCompleted: true })
  } finally { spy.mockRestore() }
  const starts = await events('mcp.request') as Array<{ detail?: Record<string, unknown> }>
  const results = await events('mcp.result') as Array<{ detail?: Record<string, unknown> }>
  const start = starts.find((row) => row.detail?.clientIdHash && row.detail?.tool === 'get_block_library' && row.detail?.sessionId === session.id)
  expect(start?.detail?.invocationId).toEqual(expect.any(String))
  expect(results.some((row) => row.detail?.invocationId === start?.detail?.invocationId && row.detail?.result === 'unknown')).toBe(true)
})
