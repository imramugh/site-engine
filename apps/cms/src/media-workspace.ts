import type { Payload } from 'payload'
import { assetUsage } from './media'

type Actor = { id?: string; roles?: string[]; disabled?: boolean } | undefined
export type MediaAsset = { id: string; filename: string; mimeType: string; width?: number | null; height?: number | null; filesize?: number | null; alt?: string | null; decorative?: boolean | null; caption?: string | null; credit?: string | null; tags?: string[] | null; deletedAt?: string | null; url?: string | null; usages: Array<{ pageId: string; pageTitle: string; locations: string[] }> }

export async function mediaWorkspace(payload: Payload, user: Actor, query: { q?: string; filter?: string } = {}) {
  const q = query.q?.trim().slice(0, 80) ?? ''
  const assets = await payload.find({ collection: 'assets', limit: 100, depth: 0, overrideAccess: false, user, where: q ? { or: [{ filename: { contains: q } }, { alt: { contains: q } }, { caption: { contains: q } }] } : undefined })
  const mapped = await Promise.all(assets.docs.filter((asset) => !asset.deletedAt).map(async (asset) => ({
    id: asset.id, filename: asset.filename ?? 'Untitled asset', mimeType: asset.mimeType ?? 'unknown', width: asset.width, height: asset.height, filesize: asset.filesize, alt: asset.alt, decorative: asset.decorative, caption: asset.caption, credit: asset.credit, tags: asset.tags, deletedAt: asset.deletedAt, url: asset.url,
    usages: await assetUsage(payload, { payload, user } as never, asset.id),
  } satisfies MediaAsset)))
  const filtered = mapped.filter((asset) => query.filter === 'missing-alt' ? !asset.decorative && !asset.alt?.trim() : query.filter === 'unused' ? !asset.usages.length : query.filter === 'large' ? (asset.filesize ?? 0) > 3 * 1024 * 1024 : true)
  return { assets: filtered, total: assets.totalDocs, truncated: assets.totalDocs > assets.docs.length }
}
