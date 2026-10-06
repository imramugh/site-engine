import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Payload } from 'payload'
import { z } from 'zod'
import { withPayloadTransaction } from './auth-transaction'
import { changeSetQuality, createNamedChangeSet, transitionChangeSet, type CapturedChange } from './editorial'
import { loadReviewModePages } from './review-mode'
import { isRetryableSQLiteError } from './sqlite'

type Current = { id: string; roles?: string[]; disabled?: boolean }
const text = (value: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value })
const error = (name: string) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify(name === 'temporarily_unavailable' ? { error: name, retryAfterSeconds: 1 } : { error: name }) }] })
const commentOutput = z.object({ id: z.string(), author: z.string(), body: z.string(), createdAt: z.string() }).strict()
const setOutput = z.object({ id: z.string().uuid(), name: z.string(), state: z.string(), revision: z.number().int().nonnegative(), checks: z.array(z.object({ name: z.string(), status: z.enum(['passed', 'failed']), errors: z.array(z.object({ collection: z.string(), id: z.string(), message: z.string() }).strict()) }).strict()), comments: z.array(commentOutput), privatePreviewURL: z.string().url().nullable() }).strict()
const id = z.string().uuid()
const comments = (value: unknown) => Array.isArray(value) ? value.flatMap((comment) => {
  if (!comment || typeof comment !== 'object' || Array.isArray(comment)) return []
  const value = comment as Record<string, unknown>
  return typeof value.id === 'string' && typeof value.author === 'string' && typeof value.body === 'string' && typeof value.createdAt === 'string'
    ? [{ id: value.id, author: value.author, body: value.body, createdAt: value.createdAt }]
    : []
}) : []

function reviewURL(id: string): string | null {
  try {
    const origin = new URL(process.env.PAYLOAD_PUBLIC_SERVER_URL ?? '')
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return null
    return new URL(`/review/${encodeURIComponent(id)}`, origin).toString()
  } catch { return null }
}

async function currentReviewURL(payload: Payload, set: Record<string, unknown>): Promise<string | null> {
  if ((set.preview as { status?: unknown } | undefined)?.status !== 'ready') return null
  const url = reviewURL(String(set.id))
  if (!url) return null
  try {
    await loadReviewModePages(payload, String(set.id))
    return url
  } catch { return null }
}

async function view(payload: Payload, set: Record<string, unknown>, checks: unknown[] = []) {
  return { id: String(set.id), name: String(set.name), state: String(set.state), revision: Number(set.revision), checks, comments: comments(set.reviewComments), privatePreviewURL: await currentReviewURL(payload, set) }
}

export function registerReviewTools(input: { server: McpServer; payload: Payload; current: Current; read: boolean; write: boolean; contentSecurity: Record<string, unknown>; writeSecurity: Record<string, unknown> }) {
  const { server, payload, current, read, write, contentSecurity, writeSecurity } = input
  const allowed = () => !current.disabled && (current.roles ?? []).some(role => ['owner', 'editor', 'approver'].includes(role))
  const readMeta = { securitySchemes: contentSecurity.securitySchemes as unknown[], authorization: contentSecurity }
  const writeMeta = { securitySchemes: writeSecurity.securitySchemes as unknown[], authorization: writeSecurity }
  const own = async (setID: string, req?: unknown) => { const set = await payload.findByID({ collection: 'change-sets', id: setID, depth: 0, overrideAccess: true, ...(req ? { req: req as never } : {}) }) as unknown as Record<string, unknown>; const actor = typeof set.actor === 'string' ? set.actor : (set.actor as { id?: string } | undefined)?.id; if (actor !== current.id) throw new Error('not_found'); return set }
  const fail = (cause: unknown) => error(isRetryableSQLiteError(cause) ? 'temporarily_unavailable' : cause instanceof Error && ['revision_conflict', 'not_found'].includes(cause.message) ? cause.message : 'write_failed')
  server.registerTool('start_change_set', { title: 'Start change set', description: 'Create an editable change set. This server cannot publish, approve, manage users, or permanently delete content.', inputSchema: z.object({ name: z.string().min(1).max(120) }).strict(), outputSchema: setOutput, _meta: writeMeta }, async ({ name }) => { if (!write || !allowed()) return error('role_access_required'); try { const set = await withPayloadTransaction(payload, async req => { req.user = current as never; return createNamedChangeSet(payload, req, current as never, name) }); return text(await view(payload, set, [])) } catch (cause) { return fail(cause) } })
  server.registerTool('get_review_status', { title: 'Get review status', description: 'Read your change-set review status. This server cannot publish, approve, manage users, or permanently delete content.', inputSchema: z.object({ id }).strict(), outputSchema: setOutput, annotations: { readOnlyHint: true }, _meta: readMeta }, async ({ id }) => { if (!read || !allowed()) return error('role_access_required'); try { const set = await own(id); const quality = await withPayloadTransaction(payload, req => changeSetQuality(payload, req, Array.isArray(set.changes) ? set.changes as CapturedChange[] : [])); return text(await view(payload, set, quality.checks)) } catch (cause) { return fail(cause) } })
  server.registerTool('submit_for_review', { title: 'Submit for review', description: 'Submit your change set for human review. This server cannot publish, approve, manage users, or permanently delete content.', inputSchema: z.object({ id, expectedRevision: z.number().int().nonnegative() }).strict(), outputSchema: setOutput, _meta: writeMeta }, async ({ id, expectedRevision }) => { if (!write || !allowed()) return error('role_access_required'); try { const set = await withPayloadTransaction(payload, async req => { req.user = current as never; const found = await own(id, req); if (Number(found.revision) !== expectedRevision) throw new Error('revision_conflict'); return transitionChangeSet({ payload, req, actor: current as never, id, action: 'submit' }) }); return text(await view(payload, set, ((set.quality as { checks?: unknown[] } | undefined)?.checks ?? []))) } catch (cause) { return fail(cause) } })
  server.registerTool('discard_change_set', { title: 'Discard change set', description: 'Discard your editable change set. This server cannot publish, approve, manage users, or permanently delete content.', inputSchema: z.object({ id, expectedRevision: z.number().int().nonnegative() }).strict(), outputSchema: setOutput, _meta: writeMeta }, async ({ id, expectedRevision }) => { if (!write || !allowed()) return error('role_access_required'); try { const set = await withPayloadTransaction(payload, async req => { req.user = current as never; const found = await own(id, req); if (Number(found.revision) !== expectedRevision) throw new Error('revision_conflict'); return transitionChangeSet({ payload, req, actor: current as never, id, action: 'discard' }) }); return text(await view(payload, set, [])) } catch (cause) { return fail(cause) } })
  server.registerTool('list_change_sets', { title: 'List change sets', description: 'List your change sets. This server cannot publish, approve, manage users, or permanently delete content.', inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(), outputSchema: z.object({ items: z.array(setOutput) }).strict(), annotations: { readOnlyHint: true }, _meta: readMeta }, async ({ limit = 25 }) => { if (!read || !allowed()) return error('role_access_required'); try { const found = await payload.find({ collection: 'change-sets', where: { actor: { equals: current.id } }, sort: '-updatedAt', limit, depth: 0, overrideAccess: true }); return text({ items: await Promise.all(found.docs.map(item => view(payload, item as unknown as Record<string, unknown>, (item as unknown as { quality?: { checks?: unknown[] } }).quality?.checks ?? []))) }) } catch (cause) { return fail(cause) } })
}
