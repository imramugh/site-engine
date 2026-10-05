import type { Payload, PayloadRequest } from 'payload'
import { assetUsage } from './media'

type SnapshotLike = { id: string; manifest?: unknown }
type AssetVersion = { id: string }

function contains(value: unknown, assetID: string): boolean {
  if (value === assetID) return true
  if (Array.isArray(value)) return value.some((item) => contains(item, assetID))
  return Boolean(value && typeof value === 'object' && Object.values(value).some((item) => contains(item, assetID)))
}

/**
 * A binned asset can disappear only when neither editable content nor an
 * immutable renderer input can name it. Snapshot manifests include frozen
 * media identities, so checking them also protects rollback and queued work.
 */
export async function retentionMediaReferences(payload: Payload, req: PayloadRequest | undefined, assetID: string): Promise<string[]> {
  const [pages, settings, snapshots, previews] = await Promise.all([
    assetUsage(payload, req as PayloadRequest, assetID),
    payload.find({ collection: 'site-settings', limit: 0, pagination: false, depth: 0, overrideAccess: true, req }),
    payload.find({ collection: 'publish-snapshots', limit: 0, pagination: false, depth: 0, overrideAccess: true, req }),
    payload.find({ collection: 'preview-render-jobs', limit: 0, pagination: false, depth: 0, overrideAccess: true, req }),
  ])
  const references = pages.map((page) => `page:${page.pageId}`)
  for (const setting of settings.docs as unknown as Array<{ id: string } & Record<string, unknown>>) if (contains(setting, assetID)) references.push(`site-settings:${setting.id}`)
  for (const snapshot of snapshots.docs as SnapshotLike[]) if (contains(snapshot.manifest, assetID)) references.push(`publish-snapshot:${snapshot.id}`)
  for (const preview of previews.docs as Array<{ id: string; liveManifest?: unknown; proposedManifest?: unknown }>) if (contains(preview.liveManifest, assetID) || contains(preview.proposedManifest, assetID)) references.push(`preview-render:${preview.id}`)
  return references
}

/** Version rows own previous immutable upload bytes and must be explicitly GC'd. */
export async function assetVersionIDsForRetention(payload: Payload, req: PayloadRequest | undefined, assetID: string): Promise<string[]> {
  const versions = await payload.find({ collection: 'asset-file-versions', where: { parentAsset: { equals: assetID } }, limit: 0, pagination: false, depth: 0, overrideAccess: true, req })
  return (versions.docs as AssetVersion[]).map((version) => String(version.id))
}
