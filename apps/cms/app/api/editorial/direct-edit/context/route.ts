import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { hasRole } from '../../../../../src/access'
import { directEditDefinitionForPage, directEditFields, type DirectEditField } from '../../../../../src/direct-edit-fields'
import { serverSessionStrategy } from '../../../../../src/identity'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }

type EditableBlock = { id: string; type: string; fields: Partial<Record<DirectEditField, string>> }

function editableBlocks(page: Record<string, unknown>): EditableBlock[] {
  const blocks = page.blocks
  if (!Array.isArray(blocks)) return []
  return blocks.flatMap((block) => {
    if (!block || typeof block !== 'object') return []
    const source = block as Record<string, unknown>
    if (typeof source.id !== 'string' || typeof source.type !== 'string') return []
    const fields = Object.fromEntries(directEditFields.flatMap((field) => directEditDefinitionForPage(page, source, field) && typeof source[field] === 'string' ? [[field, source[field]]] : [])) as Partial<Record<DirectEditField, string>>
    return Object.keys(fields).length ? [{ id: source.id, type: source.type, fields }] : []
  })
}

/** A minimal, role-filtered read model for the direct rendered-text editor. It never
 * returns arbitrary page blocks, credentials, or another editor's change set. */
export async function GET(request: Request): Promise<Response> {
  try {
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    const user = authenticated.user as { id?: string; roles?: string[] } | null
    if (!user?.id) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
    if (!hasRole(user as never, ['owner', 'approver', 'editor'])) return Response.json({ error: 'Editor access required.' }, { status: 403, headers: noStore })
    const [pages, sets] = await Promise.all([
      payload.find({ collection: 'pages', draft: true, depth: 0, limit: 50, user: user as never, overrideAccess: false }),
      payload.find({ collection: 'change-sets', where: { and: [{ actor: { equals: user.id } }, { state: { in: ['open', 'changes-requested'] } }] }, sort: '-updatedAt', limit: 50, depth: 0, user: user as never, overrideAccess: false }),
    ])
    return Response.json({
      pages: pages.docs.map((page) => ({ id: page.id, title: String(page.title), blocks: editableBlocks(page as unknown as Record<string, unknown>) })).filter((page) => page.blocks.length),
      truncated: pages.totalDocs > pages.docs.length || sets.totalDocs > sets.docs.length,
      changeSets: sets.docs.map((set) => ({ id: set.id, name: String(set.name), state: String(set.state), revision: Number(set.revision ?? 0) })),
    }, { headers: noStore })
  } catch {
    return Response.json({ error: 'Unable to load editable draft content.' }, { status: 403, headers: noStore })
  }
}
