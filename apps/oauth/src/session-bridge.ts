import type { IncomingMessage } from 'node:http'
import type { SessionBridge, SessionUser } from './server.js'

const MAX_RESPONSE_BYTES = 4_096
const DEFAULT_TIMEOUT_MS = 2_000
const allowedScopes = new Set(['mcp:content:read', 'mcp:content:write', 'mcp:redirects:read', 'mcp:redirects:write', 'mcp:leads:read', 'mcp:careers:read'])

export type HttpSessionBridgeOptions = { cmsOrigin: string; secret: string; timeoutMs?: number; fetch?: typeof fetch }
type BridgeResponse = { user: { id: string; sessionId: string; scopes: string[] } }

function validResponse(value: unknown): value is BridgeResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const outer = value as Record<string, unknown>
  if (Object.keys(outer).length !== 1 || !outer.user || typeof outer.user !== 'object' || Array.isArray(outer.user)) return false
  const user = outer.user as Record<string, unknown>
  return Object.keys(user).length === 3 && typeof user.id === 'string' && user.id.length > 0 && typeof user.sessionId === 'string' && user.sessionId.length > 0
    && Array.isArray(user.scopes) && user.scopes.every((scope) => typeof scope === 'string' && allowedScopes.has(scope))
    && new Set(user.scopes).size === user.scopes.length
}

function sessionUser(value: unknown): SessionUser | undefined {
  if (!validResponse(value)) return undefined
  return { id: value.user.id, sessionId: value.user.sessionId, enabled: true, scopes: value.user.scopes }
}

function cookieHeader(request: IncomingMessage): string | undefined {
  const cookie = request.headers.cookie
  if (typeof cookie !== 'string' || cookie.length > 4_096) return undefined
  const names = process.env.NODE_ENV === 'production'
    ? ['__Host-site_engine_session']
    : ['site_engine_session', '__Host-site_engine_session']
  return cookie.split(';').map((part) => part.trim()).find((part) => names.some((name) => part.startsWith(`${name}=`)))
}

function bridgeEndpoint(origin: string): URL | undefined {
  try {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined
    return new URL('/api/internal/oauth/session', url)
  } catch { return undefined }
}

export function createHttpSessionBridge(options: HttpSessionBridgeOptions): SessionBridge {
  const endpoint = bridgeEndpoint(options.cmsOrigin)
  if (!endpoint || !options.secret) {
    return { resolve: async () => undefined, find: async () => undefined }
  }
  const request = async (body: Record<string, string>, cookie?: string): Promise<SessionUser | undefined> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const response = await (options.fetch ?? fetch)(endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-oauth-bridge-secret': options.secret, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      })
      if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return undefined
      const reader = response.body?.getReader()
      if (!reader) return undefined
      const chunks: Uint8Array[] = []; let total = 0
      while (true) {
        const next = await reader.read()
        if (next.done) break
        total += next.value.byteLength
        if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); return undefined }
        chunks.push(next.value)
      }
      const bytes = new Uint8Array(total); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return sessionUser(JSON.parse(new TextDecoder().decode(bytes)))
    } catch { return undefined } finally { clearTimeout(timeout); controller.abort() }
  }
  return {
    resolve: async (incoming) => {
      const cookie = cookieHeader(incoming)
      return cookie ? request({ operation: 'resolve' }, cookie) : undefined
    },
    find: async (id, sessionId) => sessionId ? request({ operation: 'validate', userId: id, sessionId }) : undefined,
  }
}
