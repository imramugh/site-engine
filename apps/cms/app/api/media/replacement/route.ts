import { sqliteAuthenticationBoundary } from '../../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { hasRole } from '../../../../src/access'
import { serverSessionStrategy } from '../../../../src/identity'
import { replaceAssetFile } from '../../../../src/media-ingestion'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../../src/sqlite'

export const dynamic = 'force-dynamic'
const maxBytes = 15 * 1024 * 1024
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const sameOrigin = (request: Request) => { const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; const origin = request.headers.get('origin'); return Boolean(configured && origin === new URL(configured).origin) }
async function POSTHandler(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'CSRF origin check failed.' }, 403)
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > maxBytes + 16_384) return json({ error: 'Replacement image is too large.' }, 413)
  const payload = await getPayload({ config })
  const user = (await serverSessionStrategy.authenticate({ headers: request.headers, payload })).user
  if (!hasRole(user as never, ['owner', 'editor'])) return json({ error: 'Media workspace access required.' }, 403)
  try {
    const form = await request.formData()
    const assetID = form.get('assetId')
    const idempotencyKey = form.get('idempotencyKey')
    const upload = form.get('file')
    if (typeof assetID !== 'string' || typeof idempotencyKey !== 'string' || !uuid.test(idempotencyKey) || !(upload instanceof File) || upload.size < 1 || upload.size > maxBytes) return json({ error: 'Invalid replacement request.' }, 400)
    const bytes = Buffer.from(await upload.arrayBuffer())
    const file = { data: bytes, mimetype: upload.type, name: upload.name, size: bytes.length }
    const result = await replaceAssetFile({ payload, assetID, idempotencyKey, file, user: user as never })
    return json(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'idempotency_conflict') return json({ error: 'This replacement key was already used for different content.' }, 409)
    if (error instanceof Error && error.message === 'asset_in_bin') return json({ error: 'Restore this asset before replacing its file.' }, 409)
    return sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, { 'Cache-Control': 'no-store' }) ?? json({ error: 'Unable to replace this asset file.' }, 400)
  }
}

export const POST = sqliteAuthenticationBoundary(POSTHandler)
