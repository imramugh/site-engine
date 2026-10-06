import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import sharp from 'sharp'
import { SiteSnapshotSchema } from '@site-engine/contract'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { withPayloadTransaction } from '../src/auth-transaction'
import { currentDraftReadiness, markStaleIfNeeded, transitionChangeSet } from '../src/editorial'
import { canonicalHash, changeSetHash } from '../src/publishing'
import { prepareReviewPreview } from '../src/review-preview'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-editorial-quality-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.MEDIA_STORAGE_DIR = join(directory, 'media')
process.env.PAYLOAD_SECRET = 'synthetic-editorial-quality-secret-that-is-long-enough'
process.env.PREVIEW_THEME_VERSION = 'synthetic-theme'
process.env.PREVIEW_ENGINE_VERSION = 'synthetic-engine'
process.env.PREVIEW_CONTRACT_VERSION = '1.4.0'
const contract14BaselineFile = join(directory, 'contract-1.4.json')
const contract13BaselineFile = join(directory, 'contract-1.3.json')
const contract14Baseline = SiteSnapshotSchema.parse({ ...structuredClone(neutralFixture), settings: { ...structuredClone(neutralFixture.settings), contractVersion: '1.4.0' } })
const contract13Baseline = SiteSnapshotSchema.parse({ ...structuredClone(neutralFixture), settings: { ...structuredClone(neutralFixture.settings), contractVersion: '1.3.0' } })
writeFileSync(contract14BaselineFile, JSON.stringify(contract14Baseline))
writeFileSync(contract13BaselineFile, JSON.stringify(contract13Baseline))
process.env.INITIAL_PUBLISH_BASELINE_FILE = contract14BaselineFile

const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

const appearance = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' }
const raster = () => sharp({ create: { width: 1200, height: 800, channels: 3, background: '#155e75' } }).png().toBuffer()

async function setFor(actorID: string) {
  const found = await payload.find({ collection: 'change-sets', where: { actor: { equals: actorID } }, depth: 0, overrideAccess: true })
  expect(found.docs).toHaveLength(1)
  return found.docs[0]!
}

describe('editorial quality captures all portable change collections', () => {
  it('submits a real uploaded asset and media page, then prepares its immutable preview', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `asset-owner-${randomUUID()}@example.test`, name: 'Asset Owner', roles: ['owner'] }, overrideAccess: true })
    const data = await raster()
    const asset = await payload.create({
      collection: 'assets',
      data: { alt: 'A real synthetic teal test image', focalX: 25, focalY: 75 },
      file: { data, mimetype: 'image/png', name: 'editorial-quality.png', size: data.length },
      draft: true,
      user: owner,
      overrideAccess: false,
    })
    const section = await payload.create({ collection: 'sections', data: { name: 'Gallery', summary: 'A synthetic section that verifies uploaded editorial assets reach review preview.', slug: `gallery-${randomUUID().slice(0, 8)}`, allowedTemplates: ['standard'] }, draft: true, user: owner, overrideAccess: false })
    const page = await payload.create({ collection: 'pages', data: { title: 'Gallery page', summary: 'A synthetic gallery page that uses an uploaded image before editorial submission.', slug: `gallery-page-${randomUUID().slice(0, 8)}`, sectionId: section.id, template: 'standard', blocks: [{ id: randomUUID(), type: 'media', mediaId: asset.id, hidden: false, appearance }] }, draft: true, user: owner, overrideAccess: false })
    const set = await setFor(owner.id)
    const changes = set.changes as Array<{ collection: string; id: string }>
    const includedChangeKeys = changes.map((change) => `${change.collection}:${change.id}`)
    expect(includedChangeKeys).toEqual(expect.arrayContaining([`assets:${asset.id}`, `sections:${section.id}`, `pages:${page.id}`]))
    expect((set.changes as Array<{ collection: string; id: string; after?: Record<string, unknown> }>).find((change) => change.collection === 'assets')?.after).toMatchObject({ focalX: 25, focalY: 75 })

    const submitted = await withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: owner, id: set.id, action: 'submit' }))
    const baseline = structuredClone(contract14Baseline)
    const job = await withPayloadTransaction(payload, req => prepareReviewPreview({
      payload,
      req,
      actor: owner,
      id: set.id,
      expectedRevision: Number(submitted.revision),
      expectedChangeHash: changeSetHash(submitted.changes),
      includedChangeKeys,
      initialBaseline: { manifest: baseline, sequence: 0, versions: { themeVersion: 'synthetic-theme', engineVersion: 'synthetic-engine', contractVersion: baseline.settings.contractVersion } },
    }))
    expect(job.status).toBe('pending')
    expect((job.proposedManifest as { media: Array<{ id: string; focalX?: number; focalY?: number }> }).media).toEqual(expect.arrayContaining([expect.objectContaining({ id: asset.id, focalX: 25, focalY: 75 })]))

    await payload.update({ collection: 'assets', id: asset.id, data: { focalX: 80, focalY: 20 }, user: owner, overrideAccess: false })
    await expect(withPayloadTransaction(payload, req => prepareReviewPreview({
      payload,
      req,
      actor: owner,
      id: set.id,
      expectedRevision: Number(submitted.revision),
      expectedChangeHash: changeSetHash(submitted.changes),
      includedChangeKeys,
      initialBaseline: { manifest: baseline, sequence: 0, versions: { themeVersion: 'synthetic-theme', engineVersion: 'synthetic-engine', contractVersion: '1.4.0' } },
    }))).rejects.toThrow('reviewed revision')

    const later = await payload.find({ collection: 'change-sets', where: { and: [{ actor: { equals: owner.id } }, { state: { equals: 'open' } }] }, limit: 1, depth: 0, overrideAccess: true })
    expect(later.docs).toHaveLength(1)
    await expect(withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: owner, id: later.docs[0]!.id, action: 'discard' }))).resolves.toMatchObject({ state: 'discarded' })
    await expect(payload.findByID({ collection: 'assets', id: asset.id, overrideAccess: true })).resolves.toMatchObject({ focalX: 25, focalY: 75 })
  })

  it('keeps legacy focal-free asset captures compatible with old contracts', async () => {
    process.env.INITIAL_PUBLISH_BASELINE_FILE = contract13BaselineFile
    try {
      const owner = await payload.create({ collection: 'users', data: { email: `legacy-asset-owner-${randomUUID()}@example.test`, name: 'Legacy asset owner', roles: ['owner'] }, overrideAccess: true })
      const data = await raster()
      const asset = await payload.create({ collection: 'assets', data: { alt: 'Legacy contract image' }, file: { data, mimetype: 'image/png', name: `legacy-${randomUUID()}.png`, size: data.length }, draft: true, user: owner, overrideAccess: false })
      const set = await setFor(owner.id)
      const assetChange = (set.changes as Array<{ collection: string; after?: Record<string, unknown> }>).find((change) => change.collection === 'assets')
      expect(assetChange?.after).not.toHaveProperty('focalX')
      expect(assetChange?.after).not.toHaveProperty('focalY')
      await expect(withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: owner, id: set.id, action: 'submit' }))).resolves.toMatchObject({ state: 'submitted' })
      await expect(payload.findByID({ collection: 'assets', id: asset.id, overrideAccess: true })).resolves.toMatchObject({ focalX: 50, focalY: 50 })
    } finally {
      process.env.INITIAL_PUBLISH_BASELINE_FILE = contract14BaselineFile
    }
  })

  it('keeps legacy metadata-free asset captures nonstale and discardable', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `legacy-metadata-owner-${randomUUID()}@example.test`, name: 'Legacy metadata owner', roles: ['owner'] }, overrideAccess: true })
    const data = await raster()
    const asset = await payload.create({ collection: 'assets', data: { alt: 'Legacy metadata original', decorative: false }, file: { data, mimetype: 'image/png', name: `legacy-metadata-${randomUUID()}.png`, size: data.length }, overrideAccess: true, context: { editorialInternal: true } })
    const set = await payload.create({ collection: 'change-sets', data: { name: 'Legacy metadata capture', actor: owner.id, state: 'open', revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
    await withPayloadTransaction(payload, async (req) => { req.user = owner as never; req.headers.set('x-site-engine-change-set', set.id); await payload.update({ collection: 'assets', id: asset.id, data: { alt: 'Legacy metadata changed', decorative: false, tags: ['captured'] }, user: owner, overrideAccess: false, req }) })
    const captured = await payload.findByID({ collection: 'change-sets', id: set.id, overrideAccess: true }) as unknown as { changes: Array<{ collection: string; id: string; before: Record<string, unknown>; after: Record<string, unknown>; beforeHash: string; afterHash: string }> }
    const change = captured.changes.find((item) => item.collection === 'assets' && item.id === asset.id)!
    for (const image of [change.before, change.after]) { delete image.caption; delete image.credit; delete image.tags }
    change.beforeHash = canonicalHash(change.before); change.afterHash = canonicalHash(change.after)
    await payload.update({ collection: 'change-sets', id: set.id, data: { changes: captured.changes }, overrideAccess: true, context: { editorialInternal: true } })
    await payload.update({ collection: 'assets', id: asset.id, data: { tags: ['outside-legacy-capture'] }, overrideAccess: true, context: { editorialInternal: true } })
    const unchanged = await withPayloadTransaction(payload, req => markStaleIfNeeded(payload, captured as never, req))
    expect(unchanged).toMatchObject({ state: 'open' })
    await withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: owner, id: set.id, action: 'discard' }))
    expect(await payload.findByID({ collection: 'assets', id: asset.id, overrideAccess: true })).toMatchObject({ alt: 'Legacy metadata original', tags: ['outside-legacy-capture'] })
  })

  it('accepts a valid style guide and rejects malformed captured assets and style guides', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `style-owner-${randomUUID()}@example.test`, name: 'Style Owner', roles: ['owner'] }, overrideAccess: true })
    await payload.create({ collection: 'style-guides', data: { bannedPhrases: ['Very unique phrase'], maximumSentenceWords: 24 }, draft: true, user: owner, overrideAccess: false })
    const valid = await setFor(owner.id)
    await expect(withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: owner, id: valid.id, action: 'submit' }))).resolves.toMatchObject({ state: 'submitted' })

    for (const [collection, after] of [
      ['assets', { filename: 'missing-dimensions.png', mimeType: 'image/png', decorative: false }] as const,
      ['style-guides', { maximumSentenceWords: 1 }] as const,
    ]) {
      const actor = await payload.create({ collection: 'users', data: { email: `${collection}-${randomUUID()}@example.test`, name: `Malformed ${collection}`, roles: ['owner'] }, overrideAccess: true })
      const set = await payload.create({ collection: 'change-sets', data: { name: `Malformed ${collection}`, actor: actor.id, state: 'open', revision: 0, changes: [{ collection, id: randomUUID(), before: null, after, beforeHash: null, afterHash: null }] }, overrideAccess: true, context: { editorialInternal: true } })
      await expect(withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor, id: set.id, action: 'submit' }))).rejects.toThrow(/quality checks failed/i)
    }
  })

  it('retains an editorially imperfect SQLite draft and returns the common static-check report', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `readiness-owner-${randomUUID()}@example.test`, name: 'Readiness Owner', roles: ['owner'] }, overrideAccess: true })
    await payload.create({ collection: 'site-settings', data: { siteName: 'Readiness Test', defaultLocale: 'en' }, draft: true, user: owner, overrideAccess: false })
    const section = await payload.create({ collection: 'sections', data: { name: 'Readiness', summary: 'A section used to retain an imperfect editorial draft.', slug: `readiness-${randomUUID().slice(0, 8)}`, allowedTemplates: ['standard'] }, draft: true, user: owner, overrideAccess: false })
    const saved = await payload.create({ collection: 'pages', data: { title: 'A', summary: 'A sufficiently long summary for a retained editorial draft.', slug: `brief-${randomUUID().slice(0, 8)}`, sectionId: section.id, template: 'standard', blocks: [{ id: randomUUID(), type: 'hero', heading: 'A useful heading', body: 'A useful body.', hidden: false, appearance }] }, draft: true, user: owner, overrideAccess: false }) as unknown as Record<string, unknown>
    const returned = saved.readiness as { blockers?: Array<{ code: string }>; warnings?: Array<{ code: string }> }
    expect(await payload.findByID({ collection: 'pages', id: String(saved.id), draft: true, overrideAccess: true })).toMatchObject({ title: 'A' })
    const report = await withPayloadTransaction(payload, req => currentDraftReadiness(payload, req, { asOf: '2026-10-06T00:00:00.000Z' }))
    expect({ blockers: returned.blockers?.map(issue => issue.code), warnings: returned.warnings?.map(issue => issue.code) }).toEqual({ blockers: report.blockers.map(issue => issue.code), warnings: report.warnings.map(issue => issue.code) })
  })
})
