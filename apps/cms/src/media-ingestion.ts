import { createHash, randomUUID } from 'node:crypto'
import type { Payload, PayloadRequest } from 'payload'
import { mediaFileIdentity, validateRasterUpload } from './media'
import { mediaFocalContractVersion } from './media-workspace'
import { loadInitialPreviewBaseline } from './review-preview'

export type RasterFile = { data: Buffer; mimetype: string; name: string; size: number }
export type Actor = { id: string; roles?: string[]; disabled?: boolean }
const extensionFor = (mimeType: string) => ({ 'image/avif': 'avif', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mimeType])
const relationID = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' && 'id' in value ? String(value.id) : undefined
const queues = new Map<string, Promise<void>>()

async function serialized<T>(assetID: string, operation: () => Promise<T>): Promise<T> {
  const prior = queues.get(assetID) ?? Promise.resolve(); let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve }); const tail = prior.catch(() => undefined).then(() => current)
  queues.set(assetID, tail); await prior.catch(() => undefined)
  try { return await operation() } finally { release(); if (queues.get(assetID) === tail) queues.delete(assetID) }
}

export async function replaceAssetFile(input: { payload: Payload; assetID: string; idempotencyKey: string; file: RasterFile; user: Actor; req?: PayloadRequest }): Promise<{ asset: Record<string, unknown>; replayed: boolean }> {
  const { payload, assetID, idempotencyKey, file, user, req } = input
  await validateRasterUpload(file)
  const digest = createHash('sha256').update(file.data).digest('hex')
  return serialized(assetID, async () => {
  const asset = await payload.findByID({ collection: 'assets', id: assetID, depth: 0, overrideAccess: false, user: user as never, req }) as unknown as Record<string, unknown>
    if (asset.deletedAt) throw new Error('asset_in_bin')
    const versionKey = `${assetID}:${digest}:${idempotencyKey}`
    const found = await payload.find({ collection: 'asset-file-versions', where: { idempotencyKey: { equals: idempotencyKey } }, limit: 1, depth: 0, overrideAccess: false, user: user as never, req })
    let version = found.docs[0] as unknown as Record<string, unknown> | undefined; let created = false
    if (version && (relationID(version.parentAsset) !== assetID || version.digest !== digest)) throw new Error('idempotency_conflict')
    if (!version) {
      const extension = extensionFor(file.mimetype); if (!extension) throw new Error('invalid_media')
      try {
        version = await payload.create({ collection: 'asset-file-versions', data: { parentAsset: assetID, digest, versionKey, idempotencyKey, originalFilename: file.name }, file: { ...file, name: `${assetID}-${randomUUID()}.${extension}` }, overrideAccess: true, user: user as never, req, context: { mediaReplacementVersion: true } }) as unknown as Record<string, unknown>; created = true
      } catch (cause) {
        const raced = await payload.find({ collection: 'asset-file-versions', where: { or: [{ versionKey: { equals: versionKey } }, { idempotencyKey: { equals: idempotencyKey } }] }, limit: 1, depth: 0, overrideAccess: false, user: user as never, req })
        version = raced.docs[0] as unknown as Record<string, unknown> | undefined
        if (!version || relationID(version.parentAsset) !== assetID || version.digest !== digest) throw cause
      }
    }
    const focal = await mediaFocalContractVersion(payload, await loadInitialPreviewBaseline(), req)
    const updated = await payload.update({ collection: 'assets', id: assetID, data: { currentFileVersion: String(version.id), currentFile: mediaFileIdentity(version) }, overrideAccess: false, user: user as never, req, context: { mediaReplacement: true, mediaFocalContract: focal } })
    return { asset: { id: String(updated.id), ...mediaFileIdentity(version) }, replayed: !created }
  })
}
