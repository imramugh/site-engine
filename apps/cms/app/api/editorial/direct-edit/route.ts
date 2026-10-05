import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { executeDirectEdit, type DirectEditInput } from '../../../../src/direct-edit'
import { directEditFields } from '../../../../src/direct-edit-fields'
import { serverSessionStrategy } from '../../../../src/identity'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }
const maxBodyBytes = 4_096

function sameOrigin(request: Request): boolean {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  return Boolean(configured && origin && origin === new URL(configured).origin)
}

function input(value: unknown): DirectEditInput | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  if (typeof source.pageID !== 'string' || typeof source.blockID !== 'string' || typeof source.field !== 'string' || !directEditFields.includes(source.field as DirectEditInput['field']) || typeof source.value !== 'string' || typeof source.expectedValueHash !== 'string' || typeof source.expectedRevision !== 'number' || typeof source.changeSetID !== 'string') return undefined
  return { pageID: source.pageID, blockID: source.blockID, field: source.field as DirectEditInput['field'], value: source.value, expectedValueHash: source.expectedValueHash, expectedRevision: source.expectedRevision, changeSetID: source.changeSetID }
}

async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('INVALID_BODY')
  const chunks: Uint8Array[] = []; let size = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > maxBodyBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error('BODY_TOO_LARGE')
    }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new Error('INVALID_BODY') }
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  try {
    const edit = input(await body(request))
    if (!edit) return Response.json({ error: 'Invalid direct edit.' }, { status: 400, headers: noStore })
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    if (!authenticated.user) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
    const result = await executeDirectEdit({ payload, actor: authenticated.user as never, edit })
    return Response.json(result, { headers: noStore })
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    const status = code === 'EDITOR_ROLE_REQUIRED' || code === 'CHANGE_SET_NOT_EDITABLE' || code === 'SECTION_NOT_ACCESSIBLE' ? 403 : code === 'STALE_DIRECT_EDIT' ? 409 : code === 'BODY_TOO_LARGE' ? 413 : 400
    const message = status === 409 ? 'This field has changed. Reload before saving.' : status === 403 ? 'You cannot edit this draft.' : 'Unable to save this direct edit.'
    return Response.json({ error: message }, { status, headers: noStore })
  }
}
