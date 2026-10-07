import { sqliteAuthenticationBoundary } from '../../../../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../../../../payload.config'
import { withPayloadTransaction } from '../../../../../../src/auth-transaction'
import { parsePageEditorSaveInput, validatePageEditorSave } from '../../../../../../src/page-editor'
import { serverSessionStrategy } from '../../../../../../src/identity'
import { loadInitialPreviewBaseline } from '../../../../../../src/review-preview'
import { changeSetQuality } from '../../../../../../src/editorial'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../../../../src/sqlite'
import { ZodError } from 'zod'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }
const maxBodyBytes = 2_000_000

function validation(error: unknown): Array<{ path: string; message: string }> | undefined {
  if (!(error instanceof ZodError)) return undefined
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.length ? issue.path.map((segment) => typeof segment === 'number' ? `[${segment}]` : String(segment).replace(/[^a-zA-Z0-9_-]/g, '')).join('.').replace('.[', '[') : 'draft',
    // Keep parser diagnostics useful without reflecting submitted values,
    // unknown keys, or any other request-controlled text back to the browser.
    message: issue.code === 'too_small' ? 'Value is too short.' : issue.code === 'too_big' ? 'Value is too long.' : 'Invalid value.',
  }))
}

function sameOrigin(request: Request): boolean {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  return Boolean(configured && origin && origin === new URL(configured).origin)
}

async function boundedBody(request: Request): Promise<Record<string, unknown>> {
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
    const parsed = JSON.parse(new TextDecoder().decode(bytes))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_BODY')
    return parsed as Record<string, unknown>
  } catch {
    throw new Error('INVALID_BODY')
  }
}

async function POSTHandler(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  try {
    const [initialBaseline, body] = await Promise.all([loadInitialPreviewBaseline(), boundedBody(request)])
    const { id } = await context.params
    const save = parsePageEditorSaveInput(id, body)
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    if (!authenticated.user) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
    const result = await withPayloadTransaction(payload, async (req) => {
      const preflight = await validatePageEditorSave({ payload, req, actor: authenticated.user as never, save, initialBaseline })
      const quality = await changeSetQuality(payload, req, preflight.changes)
      const { changes: _changes, ...response } = preflight
      return { valid: true, ...response, quality }
    })
    return Response.json(result, { headers: noStore })
  } catch (error) {
    const backpressure = sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, noStore)
    if (backpressure) return backpressure
    const code = error instanceof Error ? error.message : ''
    const status = code === 'EDITOR_ROLE_REQUIRED' || code === 'CHANGE_SET_NOT_EDITABLE' || code === 'SECTION_NOT_ACCESSIBLE' ? 403 : code === 'STALE_PAGE_EDIT' || code === 'STALE_CHANGE_SET' || code === 'PAGE_METADATA_UNSUPPORTED' ? 409 : code === 'BODY_TOO_LARGE' ? 413 : 400
    const message = code === 'PAGE_METADATA_UNSUPPORTED'
      ? 'The selected theme does not support service introduction or last-reviewed metadata. Choose a compatible theme before saving these fields.'
      : status === 409 ? 'This draft or change set changed. Reload before saving.'
        : status === 403 ? 'You cannot edit this page draft.'
          : status === 413 ? 'This page draft is too large.'
            : 'The page draft is invalid.'
    const errors = validation(error)
    return Response.json(errors ? { error: message, validation: errors } : { error: message }, { status, headers: noStore })
  }
}

export const POST = sqliteAuthenticationBoundary(POSTHandler)
