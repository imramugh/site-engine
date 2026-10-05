const allowedScopes = new Set(['mcp:content:read', 'mcp:content:write', 'mcp:redirects:read', 'mcp:redirects:write'])
const managementID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export type AssistantGrant = { managementId: string; userId: string; clientId: string; clientName: string; resource: string; scopes: string[]; createdAt: number; lastUsedAt?: number; expiresAt: number }

function configured(): { endpoint: URL; secret: string } | undefined {
  const origin = process.env.OAUTH_INTERNAL_ORIGIN; const secret = process.env.OAUTH_INTROSPECTION_SECRET
  if (!origin || !secret) return undefined
  try {
    const parsed = new URL(origin); const endpoint = new URL('/internal/grants', parsed)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || endpoint.origin !== parsed.origin) return undefined
    return { endpoint, secret }
  } catch { return undefined }
}

function validGrant(value: unknown): value is AssistantGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const grant = value as Record<string, unknown>
  return Object.keys(grant).every((key) => ['managementId', 'userId', 'clientId', 'clientName', 'resource', 'scopes', 'createdAt', 'lastUsedAt', 'expiresAt'].includes(key))
    && typeof grant.managementId === 'string' && managementID.test(grant.managementId)
    && typeof grant.userId === 'string' && grant.userId.length > 0 && grant.userId.length <= 160
    && typeof grant.clientId === 'string' && grant.clientId.length > 0 && grant.clientId.length <= 256
    && typeof grant.clientName === 'string' && grant.clientName.length > 0 && grant.clientName.length <= 160
    && typeof grant.resource === 'string' && Array.isArray(grant.scopes) && grant.scopes.every((scope) => typeof scope === 'string' && allowedScopes.has(scope))
    && typeof grant.createdAt === 'number' && Number.isFinite(grant.createdAt) && typeof grant.expiresAt === 'number' && Number.isFinite(grant.expiresAt)
    && (grant.lastUsedAt === undefined || (typeof grant.lastUsedAt === 'number' && Number.isFinite(grant.lastUsedAt)))
}

async function call(body: Record<string, unknown>): Promise<unknown> {
  const target = configured(); if (!target) throw new Error('Assistant connection service is not configured.')
  const response = await fetch(target.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3_000), headers: { 'content-type': 'application/json', 'x-oauth-introspection-secret': target.secret }, body: JSON.stringify(body) })
  if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error(response.status === 404 ? 'Connected assistant was not found.' : 'Assistant connection service is unavailable.')
  const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.byteLength > 256_000) throw new Error('Assistant connection response exceeded the safe limit.')
  return JSON.parse(new TextDecoder().decode(bytes))
}

export async function listAssistantGrants(userId?: string): Promise<AssistantGrant[]> {
  const value = await call({ operation: 'list', ...(userId ? { userId } : {}) }) as { grants?: unknown }
  if (!value || !Array.isArray(value.grants) || !value.grants.every(validGrant)) throw new Error('Assistant connection service returned an invalid response.')
  return value.grants
}

export async function revokeAssistantGrant(managementId: string, userId?: string): Promise<void> {
  if (!managementID.test(managementId)) throw new Error('Connected assistant was not found.')
  const value = await call({ operation: 'revoke', managementId, ...(userId ? { userId } : {}) }) as { revoked?: unknown }
  if (value?.revoked !== true) throw new Error('Assistant connection service returned an invalid response.')
}
