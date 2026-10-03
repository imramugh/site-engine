import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import sharp from 'sharp'
import type { Payload, PayloadRequest } from 'payload'

export const PUBLIC_IMAGE_MIME_TYPES = ['image/avif', 'image/jpeg', 'image/png', 'image/webp'] as const
export const MEDIA_VARIANTS = {
  heroAvif: { width: 1600, height: 900, format: 'avif' },
  heroWebp: { width: 1600, height: 900, format: 'webp' },
  cardAvif: { width: 800, height: 600, format: 'avif' },
  cardWebp: { width: 800, height: 600, format: 'webp' },
  thumbnailAvif: { width: 400, height: 300, format: 'avif' },
  thumbnailWebp: { width: 400, height: 300, format: 'webp' },
} as const

export function mediaStorageDirectory(): string {
  return resolve(process.env.MEDIA_STORAGE_DIR || './data/media')
}

export function ensureMediaStorageDirectory(): void {
  mkdirSync(mediaStorageDirectory(), { recursive: true })
}

export function mediaPublicURL(id: string, variant: keyof typeof MEDIA_VARIANTS): string {
  return `/media/${id}/${variant}`
}

export function focalPointPosition(focalX = 50, focalY = 50): string {
  return `${Math.min(100, Math.max(0, focalX))}% ${Math.min(100, Math.max(0, focalY))}%`
}

export function mediaMetadataIssues(input: { alt?: unknown; decorative?: unknown; focalX?: unknown; focalY?: unknown }): { field: string; message: string }[] {
  const issues: { field: string; message: string }[] = []
  const decorative = input.decorative === true
  if (!decorative && (typeof input.alt !== 'string' || !input.alt.trim())) issues.push({ field: 'alt', message: 'Alt text is required unless the asset is decorative.' })
  for (const field of ['focalX', 'focalY'] as const) {
    const value = input[field]
    if (value !== undefined && (!Number.isFinite(value) || Number(value) < 0 || Number(value) > 100)) issues.push({ field, message: 'Focal point must be between 0 and 100.' })
  }
  return issues
}

/** Do not treat SVG as safe based on MIME type: this public upload surface accepts raster images only. */
export async function validateRasterUpload(file: { data: Buffer; mimetype: string; name: string; size: number }): Promise<void> {
  if (!PUBLIC_IMAGE_MIME_TYPES.includes(file.mimetype as typeof PUBLIC_IMAGE_MIME_TYPES[number])) throw new Error('Only AVIF, JPEG, PNG, and WebP raster images are accepted. SVG and active content are refused.')
  if (file.size <= 0 || file.size > 15 * 1024 * 1024) throw new Error('Image uploads must be between 1 byte and 15 MiB.')
  const metadata = await sharp(file.data, { failOn: 'error' }).metadata()
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error('Image data has no readable intrinsic dimensions.')
  const detected = metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format}`
  if (detected !== file.mimetype) throw new Error('The declared image type does not match its binary content.')
}

type AssetLike = { id: string; filename?: string | null; mimeType?: string | null; alt?: string | null; decorative?: boolean | null; width?: number | null; height?: number | null; focalX?: number | null; focalY?: number | null; deletedAt?: string | null; sizes?: Record<string, { filename?: string | null; width?: number | null; height?: number | null; mimeType?: string | null }> }
type PageLike = { id: string; title?: string; blocks?: unknown[] }

function references(value: unknown, assetId: string, path = ''): string[] {
  if (typeof value === 'string') return value === assetId ? [path] : []
  if (Array.isArray(value)) return value.flatMap((item, index) => references(item, assetId, `${path}[${index}]`))
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, item]) => references(item, assetId, path ? `${path}.${key}` : key))
}

export async function assetUsage(payload: Payload, req: PayloadRequest, assetId: string): Promise<{ pageId: string; pageTitle: string; locations: string[] }[]> {
  const pages = await payload.find({ collection: 'pages', limit: 0, pagination: false, depth: 0, draft: true, overrideAccess: true, req })
  return (pages.docs as PageLike[]).flatMap((page) => {
    const locations = references(page.blocks ?? [], assetId, 'blocks')
    return locations.length ? [{ pageId: page.id, pageTitle: page.title || page.id, locations }] : []
  })
}

export async function assertReferencedAssetsAreAccessible(payload: Payload, req: PayloadRequest, blocks: unknown): Promise<void> {
  const ids = [...new Set(references(blocks, '__never_matches__'))] // keep traversal behavior central; IDs are collected below by field names.
  void ids
  const mediaIds = new Set<string>()
  const collect = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) return value.forEach((item) => collect(item))
    if (!value || typeof value !== 'object') return
    for (const [name, item] of Object.entries(value)) {
      if ((name === 'mediaId' || name === 'posterMediaId' || name === 'captionsMediaId') && typeof item === 'string') mediaIds.add(item)
      else if (name === 'mediaIds' && Array.isArray(item)) item.forEach((id) => typeof id === 'string' && mediaIds.add(id))
      else collect(item, name)
    }
    void key
  }
  collect(blocks)
  for (const id of mediaIds) {
    const asset = await payload.findByID({ collection: 'assets', id, depth: 0, overrideAccess: true, req }).catch(() => null) as AssetLike | null
    if (!asset) throw new Error(`Referenced asset ${id} does not exist.`)
    if (asset.deletedAt) throw new Error(`Referenced asset ${id} is in the deletion bin and cannot be attached.`)
    if (!asset.decorative && !asset.alt?.trim()) throw new Error(`Referenced asset ${id} needs alt text or the decorative flag before it can be attached.`)
  }
}

export function snapshotMediaReference(asset: AssetLike) {
  if (!asset.filename || !asset.mimeType || !asset.width || !asset.height) throw new Error(`Asset ${asset.id} is missing immutable upload metadata.`)
  const original = trustedMedia(asset.filename)
  const variants = Object.fromEntries(Object.entries(MEDIA_VARIANTS).flatMap(([name, expected]) => {
    const variant = asset.sizes?.[name]
    if (!variant?.filename) return []
    const file = trustedMedia(variant.filename)
    return [[name, { filename: variant.filename, width: variant.width ?? expected.width, height: variant.height ?? expected.height, mimeType: `image/${expected.format}`, sha256: file.sha256 }]]
  }))
  return {
    id: asset.id,
    filename: asset.filename,
    sha256: original.sha256,
    ...(Object.keys(variants).length ? { variants } : {}),
    alt: asset.alt ?? undefined,
    decorative: asset.decorative === true,
    width: asset.width,
    height: asset.height,
    mimeType: asset.mimeType,
  }
}

export function variantFilename(asset: AssetLike, variant: keyof typeof MEDIA_VARIANTS): string | undefined {
  return asset.sizes?.[variant]?.filename ?? undefined
}

function safeFilename(filename: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(filename) }
function trustedMedia(filename: string): { path: string; sha256: string } {
  if (!safeFilename(filename)) throw new Error('Asset filename is unsafe.')
  const path = resolve(mediaStorageDirectory(), filename)
  if (!path.startsWith(`${mediaStorageDirectory()}/`)) throw new Error('Asset filename is unsafe.')
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Asset file ${filename} is unavailable.`)
  return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
}
export const mediaFilePath = (filename: string) => trustedMedia(filename).path
export const mediaParentPath = () => dirname(mediaStorageDirectory())
