import { getPayload } from 'payload'
import { createHash } from 'node:crypto'
import config from '../../../../payload.config'
import { withPayloadTransaction } from '../../../../src/auth-transaction'
import { recipeBlocks } from '../../../../src/block-gallery'
import { serverSessionStrategy } from '../../../../src/identity'

export const dynamic = 'force-dynamic'

function sameOrigin(request: Request): boolean {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  return Boolean(configured && origin && origin === new URL(configured).origin)
}
function isEditor(user: unknown): user is { id: string; roles?: string[] } {
  return Boolean(user && typeof user === 'object' && (user as { roles?: string[] }).roles?.some((role) => role === 'owner' || role === 'editor'))
}
function validID(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }
const maxBodyBytes = 32_768
async function boundedJSON(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBodyBytes)) throw new Error('Recipe request is too large.')
  const reader = request.body?.getReader(); if (!reader) throw new Error('A JSON recipe request is required.')
  const chunks: Uint8Array[] = []; let size = 0
  while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maxBodyBytes) { await reader.cancel(); throw new Error('Recipe request is too large.') }; chunks.push(next.value) }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('A JSON recipe request is required.')
  return parsed as Record<string, unknown>
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  return JSON.stringify(value)
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403 })
  try {
    const body = await boundedJSON(request) as { pageId?: unknown; changeSetId?: unknown; expectedRevision?: unknown; requestKey?: unknown; blocks?: unknown; blockTypes?: unknown }
    if (!validID(body.pageId) || !validID(body.changeSetId) || !validID(body.requestKey) || !Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) throw new Error('A page, open change set, request key, and current revision are required.')
    const pageID = body.pageId
    const changeSetID = body.changeSetId
    const expectedRevision = body.expectedRevision
    const requestKey = body.requestKey
    const requestHash = createHash('sha256').update(stable({ pageID, changeSetID, blocks: body.blocks ?? body.blockTypes })).digest('hex')
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    const user = authenticated.user
    if (!isEditor(user)) return Response.json({ error: 'Editor access is required.' }, { status: 403 })
    const updated = await withPayloadTransaction(payload, async (req) => {
      req.user = user
      req.headers = new Headers(request.headers)
      const set = await payload.findByID({ collection: 'change-sets', id: changeSetID, depth: 0, overrideAccess: true, req }) as { state?: unknown; actor?: unknown; revision?: unknown }
      const actor = typeof set.actor === 'string' ? set.actor : (set.actor as { id?: string } | undefined)?.id
      if (set.state !== 'open' || actor !== user.id) throw new Error('Choose an open change set that you own.')
      const replay = await payload.find({ collection: 'audit-events', where: { and: [{ event: { equals: 'block_gallery.recipe_inserted' } }, { actor: { equals: user.id } }, { 'detail.requestKey': { equals: requestKey } }] }, limit: 1, depth: 0, overrideAccess: true, req })
      if (replay.docs[0]) {
        const detail = replay.docs[0].detail as { page?: unknown; changeSet?: unknown; requestHash?: unknown }
        if (detail.page !== pageID || detail.changeSet !== changeSetID || detail.requestHash !== requestHash) throw new Error('The request key is already used for another recipe.')
        return payload.findByID({ collection: 'pages', id: pageID, depth: 0, draft: true, user, overrideAccess: false, req }) as Promise<{ id: string; blocks?: unknown }>
      }
      if (set.revision !== expectedRevision) throw new Error('The selected change set changed. Reload and try again.')
      const page = await payload.findByID({ collection: 'pages', id: pageID, depth: 0, draft: true, user, overrideAccess: false, req }) as { template?: unknown; blocks?: unknown }
      const blocks = recipeBlocks(String(page.template ?? ''), body.blocks ?? body.blockTypes, page.blocks)
      req.headers.set('x-site-engine-change-set', changeSetID)
      const result = await payload.update({ collection: 'pages', id: pageID, data: { blocks: [...(Array.isArray(page.blocks) ? page.blocks : []), ...blocks] }, draft: true, user, overrideAccess: false, req }) as { id: string; blocks?: unknown }
      await payload.create({ collection: 'audit-events', data: { event: 'block_gallery.recipe_inserted', user: user.id, actor: user.id, detail: { requestKey, requestHash, page: pageID, changeSet: changeSetID, blockTypes: blocks.map((block) => block.type) } }, overrideAccess: true, req })
      return result
    })
    const current = await payload.findByID({ collection: 'change-sets', id: changeSetID, depth: 0, overrideAccess: true }) as { revision?: unknown }
    return Response.json({ page: { id: updated.id, blocks: updated.blocks }, changeSetRevision: Number(current.revision ?? 0), message: 'Recipe blocks were captured in the selected draft change set.' }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to insert recipe blocks.'
    return Response.json({ error: message }, { status: message === 'Recipe request is too large.' ? 413 : 400, headers: { 'Cache-Control': 'no-store' } })
  }
}
