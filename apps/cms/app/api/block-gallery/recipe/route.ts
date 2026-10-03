import { getPayload } from 'payload'
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
function validID(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) }

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403 })
  try {
    const length = Number(request.headers.get('content-length') ?? '0')
    if (!Number.isFinite(length) || length > 32_768) throw new Error('Recipe request is too large.')
    const body = await request.json() as { pageId?: unknown; changeSetId?: unknown; expectedRevision?: unknown; blockTypes?: unknown }
    if (!validID(body.pageId) || !validID(body.changeSetId) || !Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) throw new Error('A page, open change set, and current revision are required.')
    const pageID = body.pageId
    const changeSetID = body.changeSetId
    const expectedRevision = body.expectedRevision
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
      if (set.revision !== expectedRevision) throw new Error('The selected change set changed. Reload and try again.')
      const page = await payload.findByID({ collection: 'pages', id: pageID, depth: 0, draft: true, user, overrideAccess: false, req }) as { template?: unknown; blocks?: unknown }
      const blocks = recipeBlocks(String(page.template ?? ''), body.blockTypes, page.blocks)
      req.headers.set('x-site-engine-change-set', changeSetID)
      return payload.update({ collection: 'pages', id: pageID, data: { blocks: [...(Array.isArray(page.blocks) ? page.blocks : []), ...blocks] }, draft: true, user, overrideAccess: false, req }) as Promise<{ id: string; blocks?: unknown }>
    })
    const current = await payload.findByID({ collection: 'change-sets', id: changeSetID, depth: 0, overrideAccess: true }) as { revision?: unknown }
    return Response.json({ page: { id: updated.id, blocks: updated.blocks }, changeSetRevision: Number(current.revision ?? 0), message: 'Recipe blocks were captured in the selected draft change set.' }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to insert recipe blocks.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
}
