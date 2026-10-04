import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { executeDirectEdit, type DirectEditInput } from '../../../../src/direct-edit'
import { serverSessionStrategy } from '../../../../src/identity'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }

function sameOrigin(request: Request): boolean {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  return Boolean(configured && origin && origin === new URL(configured).origin)
}

function input(value: unknown): DirectEditInput | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  if (typeof source.pageID !== 'string' || typeof source.blockID !== 'string' || (source.field !== 'heading' && source.field !== 'body') || typeof source.value !== 'string' || typeof source.expectedValueHash !== 'string' || typeof source.changeSetID !== 'string') return undefined
  return { pageID: source.pageID, blockID: source.blockID, field: source.field, value: source.value, expectedValueHash: source.expectedValueHash, changeSetID: source.changeSetID }
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  try {
    const body = input(await request.json())
    if (!body) return Response.json({ error: 'Invalid direct edit.' }, { status: 400, headers: noStore })
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    if (!authenticated.user) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
    const result = await executeDirectEdit({ payload, actor: authenticated.user as never, edit: body })
    return Response.json(result, { headers: noStore })
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    const status = code === 'EDITOR_ROLE_REQUIRED' || code === 'CHANGE_SET_NOT_EDITABLE' || code === 'SECTION_NOT_ACCESSIBLE' ? 403 : code === 'STALE_DIRECT_EDIT' ? 409 : 400
    const message = status === 409 ? 'This field has changed. Reload before saving.' : status === 403 ? 'You cannot edit this draft.' : 'Unable to save this direct edit.'
    return Response.json({ error: message }, { status, headers: noStore })
  }
}
