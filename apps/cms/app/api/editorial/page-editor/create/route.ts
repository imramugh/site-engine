import { sqliteAuthenticationBoundary } from '../../../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { createPageDraft } from '../../../../../src/page-creator'
import { serverSessionStrategy } from '../../../../../src/identity'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../../../src/sqlite'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }
const maxBodyBytes = 16_384

function sameOrigin(request: Request): boolean {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  return Boolean(configured && origin && origin === new URL(configured).origin)
}

async function boundedBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('INVALID_BODY')
  const chunks: Uint8Array[] = []
  let size = 0
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
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error('INVALID_BODY')
  }
}

async function POSTHandler(request: Request) {
  if (!sameOrigin(request))
    return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  try {
    const value = await boundedBody(request)
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    if (!authenticated.user)
      return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
    const result = await createPageDraft({ payload, actor: authenticated.user as never, value })
    return Response.json(result, { status: result.replayed ? 200 : 201, headers: noStore })
  } catch (error) {
    const backpressure = sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, noStore)
    if (backpressure) return backpressure
    const code = error instanceof Error ? error.message : ''
    const status = code === 'EDITOR_ROLE_REQUIRED' ? 403
      : code === 'REQUEST_KEY_REUSED' ? 409
        : code === 'BODY_TOO_LARGE' ? 413
          : 400
    const message = status === 403 ? 'You cannot create page drafts.'
      : status === 409 ? 'This creation request conflicts with an earlier request.'
        : status === 413 ? 'The page creation request is too large.'
          : 'The page details are invalid.'
    return Response.json({ error: message }, { status, headers: noStore })
  }
}

export const POST = sqliteAuthenticationBoundary(POSTHandler)
