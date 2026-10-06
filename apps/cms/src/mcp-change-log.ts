import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Payload, PayloadRequest } from 'payload'
import { z } from 'zod'
import { hasRole, type Role } from './access'
import { withPayloadTransaction } from './auth-transaction'
import { prepareReviewedRollbackCore, projectChangeLog } from './change-log'
import { hasFreshAuthentication, sessionIsUsable } from './identity'
import { isRetryableSQLiteError } from './sqlite'

type Current = { id: string; roles?: Role[] | null; disabled?: boolean | null }
const text = (value: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value })
const error = (name: string) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify(name === 'temporarily_unavailable' ? { error: name, retryAfterSeconds: 1 } : { error: name }) }] })
const rollback = z.object({ releaseID: z.string().uuid(), sequence: z.number().int().positive(), enabled: z.boolean(), note: z.string(), changes: z.array(z.object({ key: z.string(), label: z.string() }).strict()) }).strict().nullable()
const diff = z.object({ label: z.string(), entries: z.array(z.object({ record: z.string(), field: z.string(), before: z.string(), after: z.string() }).strict()), truncated: z.boolean(), pages: z.number().int().nonnegative() }).nullable()
const change = z.object({ id: z.string(), createdAt: z.string(), title: z.string(), detail: z.string(), status: z.string(), category: z.string(), source: z.string(), diff, rollback }).strict()

function userID(value: unknown) { return typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined }

async function canonicalOwner(payload: Payload, current: Current, sessionID: string, req: PayloadRequest): Promise<Current> {
  const session = await payload.findByID({ collection: 'auth-sessions', id: sessionID, depth: 0, overrideAccess: true, req })
  if (userID(session.user) !== current.id || !sessionIsUsable(session) || !hasFreshAuthentication(session)) throw new Error('fresh_authentication_required')
  const user = await payload.findByID({ collection: 'users', id: current.id, depth: 0, overrideAccess: true, req }) as unknown as Current
  if (!hasRole(user, ['owner'])) throw new Error('owner_access_required')
  return user
}

export function registerChangeLogTools(input: { server: McpServer; payload: Payload; current: Current; sessionID: string; read: boolean; write: boolean; contentSecurity: Record<string, unknown>; writeSecurity: Record<string, unknown> }) {
  const { server, payload, current, sessionID, read, write, contentSecurity, writeSecurity } = input
  const owner = () => hasRole(current, ['owner'])
  const failure = (cause: unknown) => error(isRetryableSQLiteError(cause) ? 'temporarily_unavailable' : cause instanceof Error && ['owner_access_required', 'fresh_authentication_required'].includes(cause.message) ? cause.message : 'rollback_unavailable')
  server.registerTool('list_changes', { title: 'List reviewed changes', description: 'List recent reviewed change-log entries. This server cannot publish, approve, manage users, or permanently delete content.', inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(), outputSchema: z.object({ items: z.array(change) }).strict(), annotations: { readOnlyHint: true }, _meta: { securitySchemes: contentSecurity.securitySchemes as unknown[], authorization: contentSecurity } }, async ({ limit = 25 }) => {
    if (!read) return error('role_access_required'); if (!owner()) return error('owner_access_required')
    try {
      const events = await payload.find({ collection: 'audit-events', sort: '-createdAt', limit, depth: 1, overrideAccess: true })
      const rows = await projectChangeLog(payload, events.docs as unknown as Array<Record<string, unknown>>)
      return text({ items: rows.map((row) => ({ id: row.id, createdAt: row.createdAt, title: row.title, detail: row.detail, status: row.status, category: row.category, source: row.source, diff: row.diff, rollback: row.rollback })) })
    } catch (cause) { return failure(cause) }
  })
  server.registerTool('request_rollback', { title: 'Prepare rollback for review', description: 'Prepare a rollback as a reviewable draft change set. This server cannot publish, approve, manage users, or permanently delete content.', inputSchema: z.object({ releaseID: z.string().uuid(), mode: z.enum(['release', 'change']).optional(), changeKeys: z.array(z.string()).min(1).optional() }).strict(), outputSchema: z.object({ changeSet: z.object({ id: z.string().uuid(), name: z.string(), state: z.literal('open'), revision: z.number().int().nonnegative() }).strict() }).strict(), _meta: { securitySchemes: writeSecurity.securitySchemes as unknown[], authorization: writeSecurity } }, async ({ releaseID, mode, changeKeys }) => {
    if (!write) return error('role_access_required'); if (!owner()) return error('owner_access_required')
    try {
      const set = await withPayloadTransaction(payload, async (req) => {
        const actor = await canonicalOwner(payload, current, sessionID, req)
        req.user = actor as never
        return prepareReviewedRollbackCore(payload, req, actor, releaseID, { mode, changeKeys })
      })
      return text({ changeSet: { id: String(set.id), name: String(set.name), state: 'open', revision: Number(set.revision) } })
    } catch (cause) { return failure(cause) }
  })
}
