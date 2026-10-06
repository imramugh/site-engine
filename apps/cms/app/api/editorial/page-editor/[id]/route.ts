import { sqliteAuthenticationBoundary } from '../../../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import {
  executePageEditorSave,
  pageEditorContext,
  parsePageEditorDraft,
  type PageEditorSave,
} from '../../../../../src/page-editor'
import { serverSessionStrategy } from '../../../../../src/identity'
import { loadInitialPreviewBaseline } from '../../../../../src/review-preview'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../../../src/sqlite'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }
// Forty maximum-size rich-text blocks plus JSON escaping and multibyte UTF-8
// still fit, while the streaming reader keeps the request strictly bounded.
const maxBodyBytes = 2_000_000

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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('INVALID_BODY')
    return parsed as Record<string, unknown>
  } catch {
    throw new Error('INVALID_BODY')
  }
}

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const initialBaseline = await loadInitialPreviewBaseline()
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({
      headers: request.headers,
      payload,
    })
    if (!authenticated.user)
      return Response.json(
        { error: 'Authentication required.' },
        { status: 401, headers: noStore },
      )
    const { id } = await context.params
    return Response.json(
      await pageEditorContext(payload, authenticated.user as never, id, initialBaseline),
      { headers: noStore },
    )
  } catch {
    return Response.json(
      { error: 'This page draft is unavailable.' },
      { status: 403, headers: noStore },
    )
  }
}

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!sameOrigin(request))
    return Response.json(
      { error: 'CSRF origin check failed.' },
      { status: 403, headers: noStore },
    )
  try {
    const initialBaseline = await loadInitialPreviewBaseline()
    const body = await boundedBody(request)
    if (
      !Object.keys(body).every((key) =>
        [
          'changeSetID',
          'expectedPageHash',
          'expectedChangeSetRevision',
          'draft',
        ].includes(key),
      ) ||
      typeof body.changeSetID !== 'string' ||
      typeof body.expectedPageHash !== 'string' ||
      !Number.isInteger(body.expectedChangeSetRevision)
    )
      throw new Error('INVALID_PAGE_EDIT')
    const { id } = await context.params
    const save: PageEditorSave = {
      pageID: id,
      changeSetID: body.changeSetID,
      expectedPageHash: body.expectedPageHash,
      expectedChangeSetRevision: body.expectedChangeSetRevision as number,
      draft: parsePageEditorDraft(body.draft),
    }
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({
      headers: request.headers,
      payload,
    })
    if (!authenticated.user)
      return Response.json(
        { error: 'Authentication required.' },
        { status: 401, headers: noStore },
      )
    return Response.json(
      await executePageEditorSave({
        payload,
        actor: authenticated.user as never,
        save,
        initialBaseline,
      }),
      { headers: noStore },
    )
  } catch (error) {
    const backpressure = sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, noStore)
    if (backpressure) return backpressure
    const code = error instanceof Error ? error.message : ''
    const status =
      code === 'EDITOR_ROLE_REQUIRED' ||
      code === 'CHANGE_SET_NOT_EDITABLE' ||
      code === 'SECTION_NOT_ACCESSIBLE'
        ? 403
        : code === 'STALE_PAGE_EDIT' ||
            code === 'STALE_CHANGE_SET' ||
            code === 'PAGE_METADATA_UNSUPPORTED'
          ? 409
          : code === 'BODY_TOO_LARGE'
            ? 413
            : 400
    const message =
      code === 'PAGE_METADATA_UNSUPPORTED'
        ? 'The selected theme does not support service introduction or last-reviewed metadata. Choose a theme compatible with content contract 1.4.0 before saving these fields.'
        : status === 409
          ? 'This draft or change set changed. Reload before saving.'
          : status === 403
            ? 'You cannot edit this page draft.'
            : status === 413
              ? 'This page draft is too large.'
              : 'The page draft is invalid.'
    return Response.json({ error: message }, { status, headers: noStore })
  }
}

export const GET = sqliteAuthenticationBoundary(GETHandler)
export const POST = sqliteAuthenticationBoundary(POSTHandler)
