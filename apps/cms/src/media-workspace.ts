import type { Payload, PayloadRequest } from 'payload'
import { previewThemeContext, type PreviewBaseline } from './review-preview'

type Actor = { id?: string; roles?: string[]; disabled?: boolean } | undefined
export type MediaAsset = {
  id: string
  filename: string
  mimeType: string
  width?: number | null
  height?: number | null
  filesize?: number | null
  alt?: string | null
  decorative?: boolean | null
  caption?: string | null
  credit?: string | null
  tags?: string[] | null
  focalX: number
  focalY: number
  deletedAt?: string | null
  url?: string | null
  usages: Array<{ pageId: string; pageTitle: string; locations: string[] }>
}

export async function mediaFocalContractVersion(payload: Payload, initialBaseline?: PreviewBaseline, req?: PayloadRequest): Promise<'1.4.0' | null> {
  const context = await previewThemeContext({ payload, changeSets: [], initialBaseline, req })
  return context.activeContractVersion === '1.4.0' || context.activeContractVersion === '1.5.0' || context.activeContractVersion === '1.6.0' ? '1.4.0' : null
}

export async function mediaWorkspace(
  payload: Payload,
  user: Actor,
  query: { q?: string; filter?: string; page?: number; pageSize?: number } = {},
) {
  const q = query.q?.trim() ?? ''
  const pageSize = query.pageSize ?? 24
  const page = query.page ?? 1
  if (
    q.length > 80 ||
    !Number.isSafeInteger(page) || page < 1 ||
    !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
    (query.filter !== undefined && !['all', 'missing-alt', 'unused', 'large', 'bin'].includes(query.filter))
  ) throw new Error('INVALID_MEDIA_QUERY')

  // Filter over the complete authorized set before paging. A single page scan
  // indexes references for all matching assets, avoiding one scan per asset.
  const assets = await payload.find({
    collection: 'assets', limit: 0, pagination: false, sort: '-createdAt',
    depth: 0, overrideAccess: false, user,
  })
  const usage = new Map<string, MediaAsset['usages']>(assets.docs.map(asset => [asset.id, []]))
  if (usage.size) {
    const pages = await payload.find({
      collection: 'pages', limit: 0, pagination: false, depth: 0,
      draft: true, overrideAccess: false, user,
    })
    for (const pageRecord of pages.docs) {
      const locations = new Map<string, string[]>()
      const visit = (value: unknown, path: string): void => {
        if (typeof value === 'string' && usage.has(value)) {
          const found = locations.get(value) ?? []
          found.push(path)
          locations.set(value, found)
        } else if (Array.isArray(value)) {
          value.forEach((item, index) => visit(item, `${path}[${index}]`))
        } else if (value && typeof value === 'object') {
          for (const [key, item] of Object.entries(value)) visit(item, `${path}.${key}`)
        }
      }
      visit(pageRecord.blocks ?? [], 'blocks')
      for (const [id, paths] of locations) usage.get(id)!.push({
        pageId: pageRecord.id, pageTitle: pageRecord.title || pageRecord.id, locations: paths,
      })
    }
  }
  const mapped: MediaAsset[] = assets.docs.map(asset => {
    const file: { filename?: string | null; originalFilename?: string | null; mimeType?: string | null; width?: number | null; height?: number | null; filesize?: number | null; url?: string | null } = asset.currentFile && typeof asset.currentFile === 'object' && !Array.isArray(asset.currentFile) ? asset.currentFile : asset
    return ({
    id: asset.id, filename: file.originalFilename ?? file.filename ?? 'Untitled asset', mimeType: file.mimeType ?? 'unknown',
    width: file.width, height: file.height, filesize: file.filesize, alt: asset.alt,
    decorative: asset.decorative, caption: asset.caption, credit: asset.credit, tags: asset.tags,
    focalX: typeof asset.focalX === 'number' && Number.isFinite(asset.focalX) ? Math.round(Math.min(100, Math.max(0, asset.focalX))) : 50,
    focalY: typeof asset.focalY === 'number' && Number.isFinite(asset.focalY) ? Math.round(Math.min(100, Math.max(0, asset.focalY))) : 50,
    deletedAt: asset.deletedAt, url: file.url, usages: usage.get(asset.id) ?? [],
  })})
  const searched = mapped.filter(asset => {
    if (!q) return true
    const needle = q.toLocaleLowerCase()
    const searchable = [asset.filename, asset.alt, asset.caption]
    return searchable.some((value) => typeof value === 'string' && value.toLocaleLowerCase().includes(needle))
  })
  const counts = {
    all: searched.filter(asset => !asset.deletedAt).length,
    missingAlt: searched.filter(asset => !asset.deletedAt && !asset.decorative && !asset.alt?.trim()).length,
    unused: searched.filter(asset => !asset.deletedAt && asset.usages.length === 0).length,
    large: searched.filter(asset => !asset.deletedAt && (asset.filesize ?? 0) > 3 * 1024 * 1024).length,
    bin: searched.filter(asset => Boolean(asset.deletedAt)).length,
  }
  const filtered = searched.filter(asset => {
    if (query.filter === 'bin') return Boolean(asset.deletedAt)
    if (asset.deletedAt) return false
    if (query.filter === 'missing-alt') return !asset.decorative && !asset.alt?.trim()
    if (query.filter === 'unused') return asset.usages.length === 0
    if (query.filter === 'large') return (asset.filesize ?? 0) > 3 * 1024 * 1024
    return true
  })
  const total = filtered.length
  return {
    assets: filtered.slice((page - 1) * pageSize, page * pageSize),
    total, counts, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), truncated: false,
  }
}
