import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { BlockSchemas, SiteSnapshotSchema, SectionPresets } from '@site-engine/contract'
import { createConformanceFixture } from '../src/index.mjs'
import { createGalleryFixture, galleryHash } from '../src/gallery-library.mjs'

test('gallery variations preserve the complete conformance fixture and valid unique identities', async () => {
  const theme = JSON.parse(await readFile(new URL('../../theme-starter/theme.json', import.meta.url), 'utf8'))
  const original = createConformanceFixture()
  const before = galleryHash(original)
  const options = { backgrounds: theme.contractSurface.backgrounds, presets: theme.motion.presets, presetIntents: Object.fromEntries(Object.entries(theme.motion.intentFallbacks).map(([intent, preset]) => [preset, intent])), motionBlocks: ['hero', 'featureGrid', 'faq'] }
  const fixture = createGalleryFixture(original, options)
  SiteSnapshotSchema.parse(fixture)
  assert.equal(galleryHash(original), before, 'Gallery generation must not mutate the conformance fixture.')
  assert.equal(galleryHash(fixture), galleryHash(createGalleryFixture(original, options)))
  assert.equal(new Set(fixture.pages.map(page => page.id)).size, fixture.pages.length)
  const variations = fixture.pages.filter(page => page.slug.startsWith('gallery-'))
  const blockIDs = variations.flatMap(page => page.blocks.map(block => block.id))
  assert.equal(new Set(blockIDs).size, blockIDs.length)
  for (const background of options.backgrounds) {
    const page = variations.find(page => page.slug === `gallery-background-${background}`)
    assert.deepEqual(page.blocks.map(block => block.type).sort(), Object.keys(BlockSchemas).sort())
    assert(page.blocks.every(block => block.appearance.background === background))
  }
  for (const [preset, templates] of Object.entries(SectionPresets)) {
    assert.equal(variations.find(page => page.slug === `gallery-section-${preset}`).template, templates[0])
  }
  const motion = variations.find(page => page.slug === 'gallery-motion-subtle-faq')
  assert.equal(motion.blocks.find(block => block.type === 'faq').appearance.motionPreset, 'subtle')
  assert(motion.blocks.filter(block => block.type !== 'faq').every(block => block.appearance.motionIntent === 'none'))
})

test('conformance fixtures use the candidate theme contract while retaining the legacy default', () => {
  assert.equal(createConformanceFixture().settings.contractVersion, '1.7.0')
  assert.equal(createConformanceFixture('1.8.0').settings.contractVersion, '1.8.0')
  SiteSnapshotSchema.parse(createConformanceFixture('1.8.0'))
})
