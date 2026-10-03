import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { getPayload } from 'payload'
import { z } from 'zod'
import config from '../payload.config'

const limit = new Map<string, { count: number; reset: number }>()
const maxBodyBytes = 32_768
const knownMethods = new Set(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
const knownTools = new Set(['list_sections', 'list_redirects', 'get_page', 'search_pages'])
const rateLimit = (key: string) => {
  const now = Date.now(); if (limit.size > 10_000) for (const [candidate, state] of limit) if (state.reset <= now) limit.delete(candidate)
  const state = limit.get(key)
  if (!state || state.reset <= now) { limit.set(key, { count: 1, reset: now + 60_000 }); return true }
  if (state.count >= 60) return false
  state.count += 1; return true
}
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
const page = (value: Record<string, unknown>) => ({ id: value.id, title: value.title, slug: value.slug, summary: value.summary, template: value.template, blocks: Array.isArray(value.blocks) ? value.blocks : [], sectionId: typeof value.sectionId === 'string' ? value.sectionId : value.sectionId && typeof value.sectionId === 'object' && 'id' in value.sectionId ? (value.sectionId as { id: unknown }).id : undefined })
const section = (value: Record<string, unknown>) => ({ id: value.id, name: value.name, slug: value.slug, summary: value.summary, allowedTemplates: value.allowedTemplates })
const redirect = (value: Record<string, unknown>) => ({ id: value.id, from: value.from, to: value.to, status: value.status })

type RpcRequest = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> }

async function parseRpcRequest(request: Request): Promise<RpcRequest | undefined> {
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBodyBytes)) return undefined
  const reader = request.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []; let length = 0
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break
      length += next.value.byteLength
      if (length > maxBodyBytes) { await reader.cancel(); return undefined }
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(length); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const input = value as Record<string, unknown>
    if (input.jsonrpc !== '2.0' || typeof input.method !== 'string' || input.method.length === 0 || input.method.length > 128 || (input.id !== undefined && input.id !== null && typeof input.id !== 'string' && typeof input.id !== 'number') || (input.params !== undefined && (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)))) return undefined
    const result: RpcRequest = { jsonrpc: '2.0', method: input.method }
    if (input.id !== undefined) result.id = input.id as string | number | null
    if (input.params !== undefined) result.params = input.params as Record<string, unknown>
    return result
  } catch { return undefined }
}

const validIdentifier = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value)

type Introspection = { active: true; clientId: string; resource: string; scopes: string[]; userId: string; sessionId: string; expiresAt: number } | { active: false }

async function introspect(request: Request, resource: string): Promise<Introspection> {
  const value = request.headers.get('authorization')
  if (!value?.startsWith('Bearer ') || value.length > 8_192) return { active: false }
  const token = value.slice(7)
  if (!token || /\s/.test(token)) return { active: false }
  const origin = process.env.OAUTH_INTERNAL_ORIGIN; const secret = process.env.OAUTH_INTROSPECTION_SECRET
  if (!origin || !secret) return { active: false }
  try {
    const endpoint = new URL('/internal/introspect', origin)
    const configured = new URL(origin)
    if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash || endpoint.origin !== configured.origin) return { active: false }
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2_000), headers: { 'content-type': 'application/json', 'x-oauth-introspection-secret': secret }, body: JSON.stringify({ token, resource }) })
    if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json') || Number(response.headers.get('content-length') ?? '0') > 4096) return { active: false }
    const reader = response.body?.getReader(); if (!reader) return { active: false }
    const chunks: Uint8Array[] = []; let total = 0
    while (true) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > 4096) { await reader.cancel(); return { active: false } }; chunks.push(next.value) }
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { active: false }
    const input = body as Record<string, unknown>
    if (Object.keys(input).length !== 7 || input.active !== true || !validIdentifier(input.clientId) || input.resource !== resource || !Array.isArray(input.scopes) || !input.scopes.every((scope) => scope === 'mcp:content:read' || scope === 'mcp:content:write' || scope === 'mcp:redirects:read' || scope === 'mcp:redirects:write') || new Set(input.scopes).size !== input.scopes.length || !validIdentifier(input.userId) || !validIdentifier(input.sessionId) || typeof input.expiresAt !== 'number' || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Math.floor(Date.now() / 1000)) return { active: false }
    return input as Introspection
  } catch { return { active: false } }
}

const challenge = (origin: string) => `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`

export async function handleMcp(request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } })
  const publicOrigin = process.env.PAYLOAD_PUBLIC_SERVER_URL
  let origin: URL
  try { origin = new URL(publicOrigin ?? ''); if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('invalid') } catch { return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } }) }
  const body = await parseRpcRequest(request)
  if (!body) return new Response(null, { status: 413, headers: { 'cache-control': 'no-store' } })
  const resource = `${origin.origin}/mcp`
  const identity = await introspect(request, resource)
  if (!identity.active) return new Response(null, { status: 401, headers: { 'www-authenticate': challenge(origin.origin), 'cache-control': 'no-store' } })
  if (!rateLimit(`client:${identity.clientId}`) || !rateLimit(`user:${identity.userId}`)) return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '60' } })
  const tool = typeof body.params?.name === 'string' ? body.params.name : undefined
  const required = body.method === 'tools/call' && tool === 'list_redirects' ? 'mcp:redirects:read' : body.method === 'tools/call' ? 'mcp:content:read' : undefined
  if (required && !identity.scopes.includes(required)) return new Response(JSON.stringify({ error: 'insufficient_scope', required }), { status: 403, headers: { 'content-type': 'application/json', 'www-authenticate': `${challenge(origin.origin)}, error="insufficient_scope", scope="${required}"`, 'cache-control': 'no-store' } })
  const payload = await getPayload({ config })
  let current: Awaited<ReturnType<typeof payload.findByID>>
  try { current = await payload.findByID({ collection: 'users', id: identity.userId, overrideAccess: true }) } catch { return new Response(null, { status: 401, headers: { 'www-authenticate': challenge(origin.origin), 'cache-control': 'no-store' } }) }
  if ((current as { disabled?: boolean }).disabled) return new Response(null, { status: 401, headers: { 'www-authenticate': challenge(origin.origin), 'cache-control': 'no-store' } })
  const auditMethod = knownMethods.has(body.method) ? body.method : 'unknown'
  const auditTool = body.method === 'tools/call' && knownTools.has(tool ?? '') ? tool : body.method === 'tools/call' ? 'unknown' : undefined
  await payload.create({ collection: 'audit-events', data: { event: 'mcp.request', user: identity.userId, actor: identity.userId, detail: { clientId: identity.clientId, method: auditMethod, tool: auditTool } }, overrideAccess: true })
  const read = identity.scopes.includes('mcp:content:read'); const redirects = identity.scopes.includes('mcp:redirects:read')
  const denied = (scope: string) => ({ isError: true, ...text({ error: 'insufficient_scope', required: scope }) })
  const unavailable = () => ({ isError: true, ...text({ error: 'read_failed' }) })
  const server = new McpServer({ name: 'site-engine', version: '0.1.0' }, { maxToolInputElements: 30 })
  server.tool('list_sections', 'List editable content sections.', async () => { if (!read) return denied('mcp:content:read'); try { return text((await payload.find({ collection: 'sections', limit: 100, depth: 0, user: current, overrideAccess: false })).docs.map((doc) => section(doc as unknown as Record<string, unknown>))) } catch { return unavailable() } })
  server.tool('list_redirects', 'List redirects.', async () => { if (!redirects) return denied('mcp:redirects:read'); try { return text((await payload.find({ collection: 'redirects', limit: 100, depth: 0, user: current, overrideAccess: false })).docs.map((doc) => redirect(doc as unknown as Record<string, unknown>))) } catch { return unavailable() } })
  server.tool('get_page', 'Read one draft page by id.', { id: z.string().uuid() }, async ({ id }) => { if (!read) return denied('mcp:content:read'); try { return text(page(await payload.findByID({ collection: 'pages', id, depth: 0, draft: true, user: current, overrideAccess: false }) as unknown as Record<string, unknown>)) } catch { return unavailable() } })
  server.tool('search_pages', 'Find pages by title text.', { query: z.string().min(1).max(100) }, async ({ query }) => { if (!read) return denied('mcp:content:read'); try { return text((await payload.find({ collection: 'pages', where: { title: { contains: query } }, limit: 25, depth: 0, draft: true, user: current, overrideAccess: false })).docs.map((doc) => page(doc as unknown as Record<string, unknown>))) } catch { return unavailable() } })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 32_768 })
  await server.connect(transport)
  try { return await transport.handleRequest(request, { parsedBody: body }) } finally { await server.close() }
}
