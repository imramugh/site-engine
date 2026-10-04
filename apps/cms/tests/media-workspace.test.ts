import { describe, expect, it } from 'vitest'
import { mediaWorkspace } from '../src/media-workspace'

describe('media workspace pagination', () => {
  it('filters before slicing so later matches, unused assets, and bin assets remain reachable', async () => {
    const docs = Array.from({ length: 105 }, (_, index) => ({ id: `asset-${index}`, filename: index === 104 ? 'later-match.png' : `asset-${index}.png`, mimeType: 'image/png', deletedAt: index === 103 ? '2026-10-01T00:00:00.000Z' : null, alt: index === 102 ? '' : 'Description' }))
    const payload = { find: async ({ collection, where }: { collection: string; where?: unknown }) => { if (collection !== 'assets') return { docs: [] }; const text = String(JSON.stringify(where)); const matched = text.includes('later-match') ? docs.filter((item) => item.filename.includes('later-match')) : docs; return { docs: matched, totalDocs: matched.length } } }
    const later = await mediaWorkspace(payload as never, { id: 'editor' }, { q: 'later-match', page: 1, pageSize: 10 })
    expect(later).toMatchObject({ total: 1, page: 1, totalPages: 1 }); expect(later.assets[0]?.filename).toBe('later-match.png')
    const missing = await mediaWorkspace(payload as never, { id: 'editor' }, { filter: 'missing-alt', page: 1, pageSize: 10 }); expect(missing.total).toBe(1); expect(missing.assets[0]?.id).toBe('asset-102')
    const bin = await mediaWorkspace(payload as never, { id: 'editor' }, { filter: 'bin', page: 1, pageSize: 10 }); expect(bin.total).toBe(1); expect(bin.assets[0]?.id).toBe('asset-103')
    const first = await mediaWorkspace(payload as never, { id: 'editor' }, { page: 1, pageSize: 100 }); const second = await mediaWorkspace(payload as never, { id: 'editor' }, { page: 2, pageSize: 100 }); expect(first.assets).toHaveLength(100); expect(second.assets).toHaveLength(4)
  })
})
