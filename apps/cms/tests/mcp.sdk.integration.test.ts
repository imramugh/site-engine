import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { getPayload } from 'payload'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-mcp-sdk-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-payload'
const { default: config } = await import('../payload.config.js')
const { handleMcp } = await import('../src/mcp.js')

type Token = { active?: boolean; clientId: string; userId: string; sessionId: string; scopes: string[]; resource?: string; expiresAt?: number }
const tokens = new Map<string, Token>()
let payload: Awaited<ReturnType<typeof getPayload>>
let mcpOrigin = ''
let oauthOrigin = ''
let introspections = 0
let mcpServer: ReturnType<typeof createServer>
let oauthServer: ReturnType<typeof createServer>

function requestFrom(incoming: IncomingMessage, origin: string, body: Buffer): Request {
  return new Request(`${origin}${incoming.url}`, { method: incoming.method, headers: incoming.headers as HeadersInit, body: body.length ? new Uint8Array(body) : undefined })
}

async function respond(outgoing: ServerResponse, response: Response) {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers))
  outgoing.end(Buffer.from(await response.arrayBuffer()))
}

async function startServer(handler: (incoming: IncomingMessage, outgoing: ServerResponse) => Promise<void>): Promise<{ server: ReturnType<typeof createServer>; origin: string }> {
  const server = createServer((incoming, outgoing) => { void handler(incoming, outgoing) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

function resultJson(result: unknown) {
  assert.ok(result && typeof result === 'object' && 'content' in result)
  const content = (result as { content: Array<{ type: string; text?: string }> }).content
  const block = content.find((item) => item.type === 'text')
  assert.ok(block?.text)
  return JSON.parse(block.text) as unknown
}

async function sessionFor(userId: string) {
  const now = new Date().toISOString()
  return payload.create({ collection: 'auth-sessions', data: { tokenHash: `mcp-${crypto.randomUUID()}`, user: userId, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 300_000).toISOString() }, overrideAccess: true })
}

async function clientFor(token: string) {
  const client = new Client({ name: `mcp-sdk-${token}`, version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpOrigin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } })
  await client.connect(transport)
  return { client, transport }
}

beforeAll(async () => {
  payload = await getPayload({ config })
  const oauth = await startServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    if (incoming.method !== 'POST' || incoming.url !== '/internal/introspect' || incoming.headers['x-oauth-introspection-secret'] !== 'mcp-sdk-secret') { outgoing.writeHead(404); outgoing.end(); return }
    introspections += 1
    const input = JSON.parse(Buffer.concat(chunks).toString()) as { token?: string; resource?: string }
    const token = typeof input.token === 'string' ? tokens.get(input.token) : undefined
    let sessionActive = false
    if (token && token.active !== false) try {
      const session = await payload.findByID({ collection: 'auth-sessions', id: token.sessionId, overrideAccess: true })
      sessionActive = !session.revokedAt && new Date(session.expiresAt).getTime() > Date.now() && (typeof session.user === 'string' ? session.user : session.user?.id) === token.userId
    } catch { sessionActive = false }
    const body = !token || !sessionActive ? { active: false } : { active: true, clientId: token.clientId, userId: token.userId, sessionId: token.sessionId, scopes: token.scopes, resource: token.resource ?? input.resource, expiresAt: token.expiresAt ?? Math.floor(Date.now() / 1000) + 300 }
    outgoing.writeHead(200, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify(body))
  })
  oauthServer = oauth.server; oauthOrigin = oauth.origin
  process.env.OAUTH_INTERNAL_ORIGIN = oauthOrigin
  process.env.OAUTH_INTROSPECTION_SECRET = 'mcp-sdk-secret'
  const mcp = await startServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    await respond(outgoing, await handleMcp(requestFrom(incoming, mcpOrigin, Buffer.concat(chunks))))
  })
  mcpServer = mcp.server; mcpOrigin = mcp.origin
  process.env.PAYLOAD_PUBLIC_SERVER_URL = mcpOrigin
})

afterAll(async () => {
  await payload?.destroy()
  await Promise.all([mcpServer, oauthServer].filter(Boolean).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  rmSync(directory, { recursive: true, force: true })
  delete process.env.DATABASE_URI; delete process.env.PAYLOAD_SECRET; delete process.env.PAYLOAD_PUBLIC_SERVER_URL; delete process.env.OAUTH_INTERNAL_ORIGIN; delete process.env.OAUTH_INTROSPECTION_SECRET
})

test('real MCP SDK clients receive bounded allowed content and remain isolated', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: 'mcp-editor@example.test', name: 'MCP Editor', roles: ['editor'] }, overrideAccess: true })
  const approver = await payload.create({ collection: 'users', data: { email: 'mcp-approver@example.test', name: 'MCP Approver', roles: ['approver'] }, overrideAccess: true })
  const section = await payload.create({ collection: 'sections', data: { name: 'MCP', summary: 'A synthetic section used to verify MCP returns bounded editorial content.', slug: 'mcp', allowedTemplates: ['standard'] }, user: editor, overrideAccess: false })
  const page = await payload.create({ collection: 'pages', data: { title: 'SDK page', summary: 'A synthetic page used to verify the real MCP SDK client receives blocks.', slug: 'sdk-page', sectionId: section.id, template: 'standard', blocks: [{ id: '11111111-1111-4111-8111-111111111111', type: 'hero', heading: 'MCP block', body: 'This block must be present in a bounded MCP response.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, user: editor, overrideAccess: false })
  await payload.create({ collection: 'redirects', data: { from: '/sdk-page', to: '/mcp/sdk-page' }, user: editor, overrideAccess: false })
  await payload.create({ collection: 'inquiries', data: { email: 'private@example.test', message: 'Private inquiry content must never appear in MCP output.' }, overrideAccess: true })
  await payload.update({ collection: 'users', id: editor.id, data: { emergencyTotpSecret: 'never-expose-this-secret' }, overrideAccess: true })
  const editorSession = await sessionFor(editor.id); const approverSession = await sessionFor(approver.id)
  tokens.set('editor-token', { clientId: 'editor-client', userId: editor.id, sessionId: editorSession.id, scopes: ['mcp:content:read', 'mcp:redirects:read'] })
  tokens.set('approver-token', { clientId: 'approver-client', userId: approver.id, sessionId: approverSession.id, scopes: ['mcp:content:read'] })
  const editorClient = await clientFor('editor-token'); const approverClient = await clientFor('approver-token')
  try {
    const editorTools = await editorClient.client.listTools(); expect(editorTools.tools.map((tool) => tool.name).sort()).toEqual(['get_page', 'list_redirects', 'list_sections', 'search_pages'])
    const [sections, found, selected, redirects] = await Promise.all([
      editorClient.client.callTool({ name: 'list_sections', arguments: {} }),
      editorClient.client.callTool({ name: 'search_pages', arguments: { query: 'SDK' } }),
      editorClient.client.callTool({ name: 'get_page', arguments: { id: page.id } }),
      editorClient.client.callTool({ name: 'list_redirects', arguments: {} }),
    ])
    expect(resultJson(sections)).toEqual([expect.objectContaining({ id: section.id, slug: 'mcp' })])
    expect(resultJson(found)).toEqual([expect.objectContaining({ id: page.id, title: 'SDK page' })])
    expect(resultJson(selected)).toEqual(expect.objectContaining({ id: page.id, blocks: [expect.objectContaining({ type: 'hero', heading: 'MCP block' })] }))
    expect(resultJson(redirects)).toEqual([expect.objectContaining({ from: '/sdk-page', to: '/mcp/sdk-page', status: 301 })])
    const text = JSON.stringify([sections, found, selected, redirects]); expect(text).not.toContain('private@example.test'); expect(text).not.toContain('never-expose-this-secret')
    await expect(approverClient.client.callTool({ name: 'list_redirects', arguments: {} })).rejects.toMatchObject({ code: 403 })
    const audit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'mcp.request' } }, overrideAccess: true, limit: 100 })
    expect(audit.docs.some((event) => event.detail && JSON.stringify(event.detail).includes('editor-client'))).toBe(true)
    expect(JSON.stringify(audit.docs)).not.toContain('editor-token')
    await payload.update({ collection: 'users', id: editor.id, data: { roles: ['sales'] }, overrideAccess: true })
    await expect(editorClient.client.callTool({ name: 'list_sections', arguments: {} })).rejects.toMatchObject({ code: 401 })
    await payload.update({ collection: 'users', id: editor.id, data: { roles: ['editor'] }, overrideAccess: true })
    await expect(editorClient.client.callTool({ name: 'list_sections', arguments: {} })).rejects.toMatchObject({ code: 401 })
  } finally { await Promise.all([editorClient.transport.close(), approverClient.transport.close()]) }
})

test('MCP rejects disabled, expired, revoked, wrong-resource and cookie-only credentials, and enforces both rate limits', async () => {
  const user = await payload.create({ collection: 'users', data: { email: 'mcp-disabled@example.test', name: 'MCP Disabled', roles: ['editor'], disabled: true }, overrideAccess: true })
  const disabledSession = await sessionFor(user.id)
  tokens.set('disabled-token', { clientId: 'disabled-client', userId: user.id, sessionId: disabledSession.id, scopes: ['mcp:content:read'] })
  tokens.set('expired-token', { active: false, clientId: 'expired-client', userId: user.id, sessionId: 'expired-session', scopes: [] })
  tokens.set('revoked-token', { active: false, clientId: 'revoked-client', userId: user.id, sessionId: 'revoked-session', scopes: [] })
  tokens.set('wrong-resource-token', { clientId: 'wrong-resource-client', userId: user.id, sessionId: 'wrong-resource-session', scopes: ['mcp:content:read'], resource: `${mcpOrigin}/other` })
  const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
  const post = (headers: HeadersInit = {}, body = rpc) => fetch(`${mcpOrigin}/mcp`, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers }, body })
  expect((await fetch(`${mcpOrigin}/mcp`)).status).toBe(405)
  expect((await post({ cookie: 'site_engine_session=not-a-bearer' })).status).toBe(401)
  for (const token of ['disabled-token', 'expired-token', 'revoked-token', 'wrong-resource-token']) expect((await post({ authorization: `Bearer ${token}` })).status).toBe(401)
  const contentOnly = await payload.create({ collection: 'users', data: { email: 'mcp-content-only@example.test', name: 'MCP Content Only', roles: ['approver'] }, overrideAccess: true })
  const contentOnlySession = await sessionFor(contentOnly.id)
  tokens.set('content-only-token', { clientId: 'content-only-client', userId: contentOnly.id, sessionId: contentOnlySession.id, scopes: ['mcp:content:read'] })
  const redirectCall = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_redirects', arguments: {} } })
  const scopeDenied = await post({ authorization: 'Bearer content-only-token', 'x-mcp-required-scope': 'mcp:content:read' }, redirectCall)
  expect(scopeDenied.status).toBe(403)
  expect(scopeDenied.headers.get('www-authenticate')).toContain('error="insufficient_scope", scope="mcp:redirects:read"')
  const secretLikeTool = 'do-not-write-this-tool-name-to-audit'
  expect((await post({ authorization: 'Bearer content-only-token' }, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: secretLikeTool, arguments: {} } }))).status).toBe(200)
  const unknownAudit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'mcp.request' } }, overrideAccess: true, sort: '-createdAt', limit: 1 })
  expect(unknownAudit.docs[0]?.detail).toMatchObject({ method: 'tools/call', tool: 'unknown' })
  expect(JSON.stringify(unknownAudit.docs[0])).not.toContain(secretLikeTool)
  tokens.set('bad-id-token', { clientId: 'bad identity value', userId: contentOnly.id, sessionId: contentOnlySession.id, scopes: ['mcp:content:read'] })
  expect((await post({ authorization: 'Bearer bad-id-token' })).status).toBe(401)
  const rateUser = await payload.create({ collection: 'users', data: { email: 'mcp-rate@example.test', name: 'MCP Rate', roles: ['editor'] }, overrideAccess: true })
  const rateSession = await sessionFor(rateUser.id)
  tokens.set('client-rate-token', { clientId: 'same-client', userId: rateUser.id, sessionId: rateSession.id, scopes: ['mcp:content:read'] })
  for (let count = 0; count < 60; count++) expect((await post({ authorization: 'Bearer client-rate-token' })).status).toBe(200)
  expect((await post({ authorization: 'Bearer client-rate-token' })).status).toBe(429)
  tokens.set('user-rate-token', { clientId: 'different-client', userId: rateUser.id, sessionId: rateSession.id, scopes: ['mcp:content:read'] })
  expect((await post({ authorization: 'Bearer user-rate-token' })).status).toBe(429)
})

test('MCP cancels a chunked body over the limit before introspection, Payload, or audit work', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(32_769)); },
    cancel() { cancelled = true },
  })
  const before = await payload.find({ collection: 'audit-events', where: { event: { equals: 'mcp.request' } }, overrideAccess: true, limit: 0 })
  const introspectionsBefore = introspections
  const response = await handleMcp(new Request(`${mcpOrigin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit))
  expect(response.status).toBe(413)
  expect(cancelled).toBe(true)
  expect(introspections).toBe(introspectionsBefore)
  const after = await payload.find({ collection: 'audit-events', where: { event: { equals: 'mcp.request' } }, overrideAccess: true, limit: 0 })
  expect(after.totalDocs).toBe(before.totalDocs)
})
