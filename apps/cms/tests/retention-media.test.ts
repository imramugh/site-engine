import { describe, expect, it } from 'vitest'
import { retentionMediaReferences } from '../src/retention-media'

describe('retention media references', () => {
  it('blocks a binned asset named by draft pages, settings, immutable snapshots, and queued preview manifests', async () => {
    const assetID = 'asset-under-retention'
    const payload = {
      find: async ({ collection }: { collection: string }) => {
        if (collection === 'pages') return { docs: [{ id: 'page-1', title: 'Draft page', blocks: [{ mediaId: assetID }] }] }
        if (collection === 'site-settings') return { docs: [{ id: 'default', logos: { primaryLight: assetID } }] }
        if (collection === 'publish-snapshots') return { docs: [{ id: 'snapshot-live', manifest: { media: [{ id: assetID, filename: 'frozen.webp' }] } }] }
        if (collection === 'preview-render-jobs') return { docs: [{ id: 'preview-queued', proposedManifest: { media: [{ id: assetID }] } }] }
        return { docs: [] }
      },
    }
    await expect(retentionMediaReferences(payload as never, undefined, assetID)).resolves.toEqual(expect.arrayContaining(['page:page-1', 'site-settings:default', 'publish-snapshot:snapshot-live', 'preview-render:preview-queued']))
  })
})
