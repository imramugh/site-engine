import { sqliteAuthenticationBoundary } from '../../../../src/sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { hasRole } from '../../../../src/access'
import { serverSessionStrategy } from '../../../../src/identity'
import { mediaFocalContractVersion } from '../../../../src/media-workspace'
import { loadInitialPreviewBaseline } from '../../../../src/review-preview'
import { mediaFileIdentity, validateRasterUpload } from '../../../../src/media'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../../src/sqlite'

export const dynamic = 'force-dynamic'
const maxBytes = 15 * 1024 * 1024
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const sameOrigin = (request: Request) => { const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; const origin = request.headers.get('origin'); return Boolean(configured && origin === new URL(configured).origin) }
const relationID = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' && 'id' in value ? String(value.id) : undefined
const replacementQueues = new Map<string, Promise<void>>()

async function serializeReplacement<T>(assetID: string, operation: () => Promise<T>): Promise<T> {
  const previous = replacementQueues.get(assetID) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.catch(() => undefined).then(() => current)
  replacementQueues.set(assetID, tail)
  await previous.catch(() => undefined)
  try { return await operation() } finally {
    release()
    if (replacementQueues.get(assetID) === tail) replacementQueues.delete(assetID)
  }
}

const extensionFor = (mimeType: string) => ({ 'image/avif': 'avif', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mimeType])

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
    await validateRasterUpload(file)
    const digest = createHash('sha256').update(bytes).digest('hex')
    return await serializeReplacement(assetID, async () => {
      const asset = await payload.findByID({ collection: 'assets', id: assetID, depth: 0, overrideAccess: false, user })
      if (asset.deletedAt) return json({ error: 'Restore this asset before replacing its file.' }, 409)
      const versionKey = `${assetID}:${digest}:${idempotencyKey}`
      const byIdempotency = await payload.find({ collection: 'asset-file-versions', where: { idempotencyKey: { equals: idempotencyKey } }, limit: 1, depth: 0, overrideAccess: false, user })
      let version = byIdempotency.docs[0] as unknown as Record<string, unknown> | undefined
      let created = false
      if (version && (relationID(version.parentAsset) !== assetID || version.digest !== digest)) return json({ error: 'This replacement key was already used for different content.' }, 409)
      if (!version) {
        try {
          const extension = extensionFor(upload.type)
          if (!extension) throw new Error('Unsupported replacement image type.')
          const immutableFile = { ...file, name: `${assetID}-${randomUUID()}.${extension}` }
          version = await payload.create({ collection: 'asset-file-versions', data: { parentAsset: assetID, digest, versionKey, idempotencyKey, originalFilename: upload.name }, file: immutableFile, overrideAccess: true, user, context: { mediaReplacementVersion: true } }) as unknown as Record<string, unknown>
          created = true
        } catch (error) {
          const raced = await payload.find({ collection: 'asset-file-versions', where: { or: [{ versionKey: { equals: versionKey } }, { idempotencyKey: { equals: idempotencyKey } }] }, limit: 1, depth: 0, overrideAccess: false, user })
          version = raced.docs[0] as unknown as Record<string, unknown> | undefined
          if (!version || relationID(version.parentAsset) !== assetID || version.digest !== digest) throw error
        }
      }
      const focalContract = await mediaFocalContractVersion(payload, await loadInitialPreviewBaseline())
      const updated = await payload.update({ collection: 'assets', id: assetID, data: { currentFileVersion: String(version.id), currentFile: mediaFileIdentity(version) }, overrideAccess: false, user, context: { mediaReplacement: true, mediaFocalContract: focalContract } })
      return json({ asset: { id: updated.id, ...mediaFileIdentity(version) }, replayed: !created })
    })
  } catch (error) {
    return sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, { 'Cache-Control': 'no-store' }) ?? json({ error: 'Unable to replace this asset file.' }, 400)
  }
}

export const POST = sqliteAuthenticationBoundary(POSTHandler)
