import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Payload, PayloadRequest } from 'payload'
import { z } from 'zod'
import { hasRole, type Role } from './access'
import { withPayloadTransaction } from './auth-transaction'
import { changeSetQuality } from './editorial'
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

async function canonicalReviewer(payload: Payload, current: Current, sessionID: string, req: PayloadRequest): Promise<Current> {
  const session = await payload.findByID({ collection: 'auth-sessions', id: sessionID, depth: 0, overrideAccess: true, req })
  if (userID(session.user) !== current.id || !sessionIsUsable(session) || !hasFreshAuthentication(session)) throw new Error('fresh_authentication_required')
  const user = await payload.findByID({ collection: 'users', id: current.id, depth: 0, overrideAccess: true, req }) as unknown as Current
  if (!hasRole(user, ['owner', 'approver'])) throw new Error('owner_access_required')
  return user
}

export function registerChangeLogTools(input: { server: McpServer; payload: Payload; current: Current; sessionID: string; read: boolean; write: boolean; contentSecurity: Record<string, unknown>; writeSecurity: Record<string, unknown> }) {
  const { server, payload, current, sessionID, read, write, contentSecurity, writeSecurity } = input
  const owner = () => hasRole(current, ['owner'])
  const reviewer = () => hasRole(current, ['owner', 'approver'])
  const reviewContentSecurity: Record<string, unknown> = { ...contentSecurity, requiredRoles: ['owner', 'approver'] }
  const reviewWriteSecurity: Record<string, unknown> = { ...writeSecurity, requiredRoles: ['owner', 'approver'] }
  const failure = (cause: unknown) => error(isRetryableSQLiteError(cause) ? 'temporarily_unavailable' : cause instanceof Error && ['owner_access_required', 'fresh_authentication_required'].includes(cause.message) ? cause.message : 'rollback_unavailable')
  server.registerTool('list_changes', { title: 'List reviewed changes', description: 'List recent reviewed content and publication changes. This server cannot publish, approve, manage users, or permanently delete content.', inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(), outputSchema: z.object({ items: z.array(change) }).strict(), annotations: { readOnlyHint: true }, _meta: { securitySchemes: reviewContentSecurity.securitySchemes as unknown[], authorization: reviewContentSecurity } }, async ({ limit = 25 }) => {
    if (!read) return error('role_access_required'); if (!reviewer()) return error('owner_access_required')
    try {
      const events = await payload.find({ collection: 'audit-events', ...(owner() ? {} : { where: { or: [{ event: { like: 'editorial.%' } }, { event: { like: 'publish.%' } }] } }), sort: '-createdAt', limit, depth: 1, overrideAccess: true })
      const rows = await projectChangeLog(payload, events.docs as unknown as Array<Record<string, unknown>>)
      return text({ items: rows.map((row) => ({ id: row.id, createdAt: row.createdAt, title: row.title, detail: row.detail, status: row.status, category: row.category, source: row.source, diff: row.diff, rollback: row.rollback })) })
    } catch (cause) { return failure(cause) }
  })
  server.registerTool('request_rollback', { title: 'Prepare rollback for review', description: 'Prepare a rollback as a reviewable draft change set. This server cannot publish, approve, manage users, or permanently delete content.', inputSchema: z.object({ releaseID: z.string().uuid(), mode: z.enum(['release', 'change']).optional(), changeKeys: z.array(z.string()).min(1).optional() }).strict(), outputSchema: z.object({ changeSet: z.object({ id: z.string().uuid(), name: z.string(), state: z.literal('open'), revision: z.number().int().nonnegative() }).strict(), checks: z.array(z.unknown()), warnings: z.array(z.string()), readiness: z.unknown() }).strict(), _meta: { securitySchemes: reviewWriteSecurity.securitySchemes as unknown[], authorization: reviewWriteSecurity } }, async ({ releaseID, mode, changeKeys }) => {
    if (!write) return error('role_access_required'); if (!reviewer()) return error('owner_access_required')
    try {
      const set = await withPayloadTransaction(payload, async (req) => {
        const actor = await canonicalReviewer(payload, current, sessionID, req)
        req.user = actor as never
        const set = await prepareReviewedRollbackCore(payload, req, actor, releaseID, { mode, changeKeys }) as unknown as { id: string; name: string; revision: number; changes?: unknown[] }
        const quality = await changeSetQuality(payload, req, Array.isArray(set.changes) ? set.changes as Parameters<typeof changeSetQuality>[2] : [])
        return { set, quality }
      })
      return text({ changeSet: { id: String(set.set.id), name: String(set.set.name), state: 'open', revision: Number(set.set.revision) }, checks: set.quality.checks, warnings: set.quality.warnings, readiness: set.quality.readiness })
    } catch (cause) { return failure(cause) }
  })
}
