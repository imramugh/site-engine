import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { getPayload } from 'payload'
import { z } from 'zod'
import config from '../payload.config'

const limit = new Map<string, { count: number; reset: number }>()
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
    if (Object.keys(input).length !== 7 || input.active !== true || typeof input.clientId !== 'string' || input.resource !== resource || !Array.isArray(input.scopes) || !input.scopes.every((scope) => scope === 'mcp:content:read' || scope === 'mcp:content:write' || scope === 'mcp:redirects:read' || scope === 'mcp:redirects:write') || new Set(input.scopes).size !== input.scopes.length || typeof input.userId !== 'string' || typeof input.sessionId !== 'string' || typeof input.expiresAt !== 'number' || input.expiresAt <= Math.floor(Date.now() / 1000)) return { active: false }
    return input as Introspection
  } catch { return { active: false } }
}

const challenge = (origin: string) => `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`

export async function handleMcp(request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } })
  const publicOrigin = process.env.PAYLOAD_PUBLIC_SERVER_URL
  let origin: URL
  try { origin = new URL(publicOrigin ?? ''); if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('invalid') } catch { return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } }) }
  const resource = `${origin.origin}/mcp`
  const identity = await introspect(request, resource)
  if (!identity.active) return new Response(null, { status: 401, headers: { 'www-authenticate': challenge(origin.origin), 'cache-control': 'no-store' } })
  if (!rateLimit(`client:${identity.clientId}`) || !rateLimit(`user:${identity.userId}`)) return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '60' } })
  const length = Number(request.headers.get('content-length') ?? '0'); if (!Number.isFinite(length) || length > 32_768) return new Response(null, { status: 413, headers: { 'cache-control': 'no-store' } })
  let method: string | undefined; let tool: string | undefined
  try {
    const body = await request.clone().json() as { method?: unknown; params?: { name?: unknown } }
    method = typeof body.method === 'string' ? body.method : undefined
    tool = typeof body.params?.name === 'string' ? body.params.name : undefined
  } catch { return new Response(null, { status: 400, headers: { 'cache-control': 'no-store' } }) }
  const required = method === 'tools/call' && tool === 'list_redirects' ? 'mcp:redirects:read' : method === 'tools/call' ? 'mcp:content:read' : undefined
  if (required && !identity.scopes.includes(required)) return new Response(JSON.stringify({ error: 'insufficient_scope', required }), { status: 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  const payload = await getPayload({ config })
  let current: Awaited<ReturnType<typeof payload.findByID>>
  try { current = await payload.findByID({ collection: 'users', id: identity.userId, overrideAccess: true }) } catch { return new Response(null, { status: 401, headers: { 'www-authenticate': challenge(origin.origin), 'cache-control': 'no-store' } }) }
  if ((current as { disabled?: boolean }).disabled) return new Response(null, { status: 401, headers: { 'www-authenticate': challenge(origin.origin), 'cache-control': 'no-store' } })
  await payload.create({ collection: 'audit-events', data: { event: 'mcp.request', user: identity.userId, actor: identity.userId, detail: { clientId: identity.clientId, method, tool } }, overrideAccess: true })
  const read = identity.scopes.includes('mcp:content:read'); const redirects = identity.scopes.includes('mcp:redirects:read')
  const denied = (scope: string) => text({ error: 'insufficient_scope', required: scope })
  const server = new McpServer({ name: 'site-engine', version: '0.1.0' }, { maxToolInputElements: 30 })
  server.tool('list_sections', 'List editable content sections.', async () => read ? text((await payload.find({ collection: 'sections', limit: 100, depth: 0, user: current, overrideAccess: false })).docs.map((doc) => section(doc as unknown as Record<string, unknown>))) : denied('mcp:content:read'))
  server.tool('list_redirects', 'List redirects.', async () => redirects ? text((await payload.find({ collection: 'redirects', limit: 100, depth: 0, user: current, overrideAccess: false })).docs.map((doc) => redirect(doc as unknown as Record<string, unknown>))) : denied('mcp:redirects:read'))
  server.tool('get_page', 'Read one draft page by id.', { id: z.string().uuid() }, async ({ id }) => read ? text(page(await payload.findByID({ collection: 'pages', id, depth: 0, draft: true, user: current, overrideAccess: false }) as unknown as Record<string, unknown>)) : denied('mcp:content:read'))
  server.tool('search_pages', 'Find pages by title text.', { query: z.string().min(1).max(100) }, async ({ query }) => read ? text((await payload.find({ collection: 'pages', where: { title: { contains: query } }, limit: 25, depth: 0, draft: true, user: current, overrideAccess: false })).docs.map((doc) => page(doc as unknown as Record<string, unknown>))) : denied('mcp:content:read'))
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 32_768 })
  await server.connect(transport)
  try { return await transport.handleRequest(request) } finally { await server.close() }
}
