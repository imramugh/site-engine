import { describe, expect, it, vi } from 'vitest'
import { mediaWorkspace } from '../src/media-workspace'

const docs = Array.from({ length: 105 }, (_, index) => ({
  id: `asset-${index}`,
  filename: index === 104 ? 'later-match.png' : `asset-${index}.png`,
  mimeType: 'image/png',
  deletedAt: index === 103 ? '2026-10-01T00:00:00.000Z' : null,
  alt: index === 102 ? '' : 'Description',
  focalX: index === 104 ? 27.6 : undefined,
  focalY: index === 104 ? 72.2 : undefined,
  privateInternalField: 'must not be exposed',
}))
function fixture() {
  const find = vi.fn(async ({ collection, where }: { collection: string; where?: unknown }) => {
    if (collection === 'pages') return { docs: [{ id: 'page-1', title: 'Used page', blocks: [{ mediaId: 'asset-104' }, { gallery: ['asset-104'] }] }] }
    const matched = JSON.stringify(where)?.includes('later-match') ? docs.filter(item => item.filename.includes('later-match')) : docs
    return { docs: matched, totalDocs: matched.length }
  })
  return { find }
}
const user = { id: 'editor', roles: ['editor'] }

describe('media workspace pagination', () => {
  it('keeps later matches and complete filtered totals reachable without scanning pages for each asset', async () => {
    const payload = fixture()
    const later = await mediaWorkspace(payload as never, user, { q: 'later-match', page: 1, pageSize: 10 })
    expect(later).toMatchObject({ total: 1, page: 1, totalPages: 1 })
    expect(later.assets[0]).toMatchObject({ filename: 'later-match.png', focalX: 28, focalY: 72, usages: [{ pageId: 'page-1', pageTitle: 'Used page', locations: ['blocks[0].mediaId', 'blocks[1].gallery[0]'] }] })
    expect(later.assets[0]).not.toHaveProperty('privateInternalField')
    const missing = await mediaWorkspace(payload as never, user, { filter: 'missing-alt', pageSize: 10 })
    expect(missing.total).toBe(1)
    expect(missing.assets[0]?.id).toBe('asset-102')
    expect(missing.assets[0]).toMatchObject({ focalX: 50, focalY: 50 })
    const bin = await mediaWorkspace(payload as never, user, { filter: 'bin', pageSize: 10 })
    expect(bin.total).toBe(1)
    expect(bin.assets[0]?.id).toBe('asset-103')
    const unused = await mediaWorkspace(payload as never, user, { filter: 'unused', pageSize: 100 })
    expect(unused.total).toBe(103)
    expect(unused.assets.some(asset => asset.id === 'asset-104')).toBe(false)
    const first = await mediaWorkspace(payload as never, user, { page: 1, pageSize: 100 })
    const second = await mediaWorkspace(payload as never, user, { page: 2, pageSize: 100 })
    expect(first.assets).toHaveLength(100)
    expect(second.assets).toHaveLength(4)
    expect(second.totalPages).toBe(2)
    expect(await mediaWorkspace(payload as never, user, { page: 3, pageSize: 100 })).toMatchObject({ assets: [], total: 104, totalPages: 2 })
    expect(payload.find).toHaveBeenCalledTimes(14)
    for (const [query] of payload.find.mock.calls) expect(query).toMatchObject({ overrideAccess: false, user, pagination: false })
  })

  it.each([
    { page: 0 }, { page: -1 }, { page: NaN }, { page: 1.5 }, { page: Infinity },
    { pageSize: 0 }, { pageSize: 101 }, { pageSize: 2.5 }, { q: 'x'.repeat(81) }, { filter: 'unknown' },
  ])('rejects invalid pagination and filters before reading data: %j', async query => {
    const payload = fixture()
    await expect(mediaWorkspace(payload as never, user, query)).rejects.toThrow('INVALID_MEDIA_QUERY')
    expect(payload.find).not.toHaveBeenCalled()
  })
})
