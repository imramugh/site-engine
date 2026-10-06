import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Payload } from 'payload'
import { z } from 'zod'
import { withPayloadTransaction } from './auth-transaction'
import { canonicalFocalPoint } from './media'
import { mediaFocalContractVersion, mediaWorkspace } from './media-workspace'
import { loadInitialPreviewBaseline } from './review-preview'
import { isRetryableSQLiteError } from './sqlite'

type Current = { id: string; roles?: string[]; disabled?: boolean }

const mediaItem = z.object({ id: z.string().uuid(), filename: z.string(), mimeType: z.string(), width: z.number().nullable().optional(), height: z.number().nullable().optional(), alt: z.string().nullable().optional(), decorative: z.boolean().nullable().optional(), caption: z.string().nullable().optional(), credit: z.string().nullable().optional(), tags: z.array(z.string()).nullable().optional(), focalX: z.number(), focalY: z.number(), deletedAt: z.string().nullable().optional(), usages: z.array(z.object({ pageId: z.string(), pageTitle: z.string(), locations: z.array(z.string()) }).strict()) }).strict()
const findInput = z.object({ q: z.string().max(80).optional(), tag: z.string().max(80).optional(), usage: z.enum(['any', 'used', 'unused']).optional(), filter: z.enum(['all', 'missing-alt', 'unused', 'large', 'bin']).optional(), page: z.number().int().min(1).max(1000).optional(), pageSize: z.number().int().min(1).max(100).optional() }).strict()
const updateInput = z.object({ id: z.string().uuid(), changeSetId: z.string().uuid(), expectedChangeSetRevision: z.number().int().nonnegative(), alt: z.string().max(240), decorative: z.boolean(), caption: z.string().max(300).optional(), credit: z.string().max(240).optional(), tags: z.array(z.string().min(1).max(80)).max(12).optional(), focalX: z.number().finite().min(0).max(100), focalY: z.number().finite().min(0).max(100) }).strict()

const text = <T extends Record<string, unknown>>(value: T) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value })
const error = (code: string) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify(code === 'temporarily_unavailable' ? { error: code, retryAfterSeconds: 1 } : { error: code }) }] })
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function registerMediaTools(input: { server: McpServer; payload: Payload; current: Current; read: boolean; write: boolean; contentSecurity: Record<string, unknown>; writeSecurity: Record<string, unknown> }) {
  const { server, payload, current, read, write, contentSecurity, writeSecurity } = input
  const roles = current.roles ?? []
  const mediaRead = read && roles.some((role) => ['owner', 'editor', 'approver'].includes(role))
  const mediaWrite = write && roles.some((role) => ['owner', 'editor'].includes(role))
  const readMeta = { securitySchemes: (contentSecurity.securitySchemes as unknown[]), authorization: contentSecurity }
  const writeMeta = { securitySchemes: (writeSecurity.securitySchemes as unknown[]), authorization: writeSecurity }
  const allMedia = async (query: { q?: string; filter?: string }) => {
    const first = await mediaWorkspace(payload, current, { ...query, page: 1, pageSize: 100 })
    const pages = [first]
    for (let page = 2; page <= first.totalPages; page++) pages.push(await mediaWorkspace(payload, current, { ...query, page, pageSize: 100 }))
    return { first, assets: pages.flatMap((item) => item.assets) }
  }

  server.registerTool('find_media', { title: 'Find media', description: 'Find scoped media by text, tag, status, or usage. This server cannot publish, approve, manage users, or permanently delete content.', inputSchema: findInput, outputSchema: z.object({ assets: z.array(mediaItem), total: z.number(), page: z.number(), pageSize: z.number(), totalPages: z.number() }).strict(), annotations: { readOnlyHint: true }, _meta: readMeta }, async ({ q, tag, usage, filter, page = 1, pageSize = 24 }) => {
    if (!mediaRead) return error('role_access_required')
    try {
      const found = await allMedia({ q, filter })
      const tagged = tag ? found.assets.filter((asset) => asset.tags?.includes(tag)) : found.assets
      const assets = usage === 'used' ? tagged.filter((asset) => asset.usages.length > 0) : usage === 'unused' ? tagged.filter((asset) => asset.usages.length === 0) : tagged
      return text(clean({ assets: assets.slice((page - 1) * pageSize, page * pageSize), total: assets.length, page, pageSize, totalPages: Math.max(1, Math.ceil(assets.length / pageSize)) }))
    } catch { return error('read_failed') }
  })
  server.registerTool('get_media_usage', { title: 'Get media usage', description: 'Read the scoped draft-page references for one media asset. This server cannot publish, approve, manage users, or permanently delete content.', inputSchema: z.object({ id: z.string().uuid() }).strict(), outputSchema: z.object({ id: z.string().uuid(), usages: z.array(z.object({ pageId: z.string(), pageTitle: z.string(), locations: z.array(z.string()) }).strict()) }).strict(), annotations: { readOnlyHint: true }, _meta: readMeta }, async ({ id }) => {
    if (!mediaRead) return error('role_access_required')
    try { const found = await allMedia({}); const asset = found.assets.find((candidate) => candidate.id === id); return asset ? text({ id, usages: asset.usages }) : error('not_found') } catch { return error('read_failed') }
  })
  server.registerTool('update_media', { title: 'Update media metadata', description: 'Update media metadata and focal point in an explicit revisioned change set. Returns a draft result only; this server cannot publish, approve, manage users, or permanently delete content.', inputSchema: updateInput, _meta: writeMeta }, async ({ id, changeSetId, expectedChangeSetRevision, alt, decorative, caption, credit, tags, focalX, focalY }) => {
    if (!mediaWrite) return error('role_access_required')
    try {
      const result = await withPayloadTransaction(payload, async (req) => {
        req.user = current as never
        req.headers.set('x-site-engine-change-set', changeSetId)
        const set = await payload.findByID({ collection: 'change-sets', id: changeSetId, depth: 0, overrideAccess: true, req }) as unknown as { revision?: number; state?: string; actor?: string | { id?: string } }
        const actor = typeof set.actor === 'string' ? set.actor : set.actor?.id
        if (set.revision !== expectedChangeSetRevision || actor !== current.id || !['open', 'changes-requested'].includes(String(set.state))) throw new Error('revision_conflict')
        const focalContract = await mediaFocalContractVersion(payload, await loadInitialPreviewBaseline(), req)
        const asset = await payload.update({ collection: 'assets', id, data: { alt, decorative, caption, credit, tags, ...(focalContract ? { focalX: canonicalFocalPoint(focalX), focalY: canonicalFocalPoint(focalY) } : {}) }, user: current as never, overrideAccess: false, req, context: { mediaFocalContract: focalContract } }) as unknown as { id: string }
        const changed = await payload.findByID({ collection: 'change-sets', id: changeSetId, depth: 0, overrideAccess: true, req }) as unknown as { revision: number; quality?: { checks?: unknown[] } }
        return { id: asset.id, revision: changed.revision, checks: changed.quality?.checks ?? [] }
      })
      return text({ draft: { assetId: result.id, changeSetId, changeSetRevision: result.revision }, checks: result.checks })
    } catch (cause) { return error(isRetryableSQLiteError(cause) ? 'temporarily_unavailable' : cause instanceof Error && cause.message === 'revision_conflict' ? 'revision_conflict' : 'write_failed') }
  })
}
