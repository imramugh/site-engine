import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGalleryFixture, galleryHash, galleryLibraryDocument } from '../src/gallery-library.mjs'

const snapshot = { settings: { sections: [{ pageIds: ['a', 'b'] }] }, pages: [
  { id: 'a', slug: 'landing', title: 'Landing', summary: '', template: 'landing', blocks: [{ id: 'a1', appearance: { background: 'default', motionIntent: 'none' } }] },
  { id: 'b', slug: 'standard', title: 'Standard', summary: '', template: 'standard', blocks: [{ id: 'b1', type: 'featureGrid', items: [{ title: 'One' }, { title: 'Two' }], appearance: { background: 'default', motionIntent: 'none' } }] },
  { id: 'c', slug: 'listing', title: 'Listing', summary: '', template: 'listing', blocks: [{ id: 'c1', type: 'richText', appearance: { background: 'default', motionIntent: 'none' } }] },
] }

test('gallery fixture derives neutral background, motion, and common appearance pages', () => {
  const value = createGalleryFixture(snapshot, { backgrounds: ['default', 'inverse'], presets: ['trace'], presetIntents: { trace: 'ambient' } })
  assert.equal(value.pages.length, 3 + 2 + 1 + 8 + 6 + 3)
  assert.equal(value.pages.find((page) => page.slug === 'gallery-background-inverse').blocks[0].appearance.background, 'inverse')
  assert.equal(value.pages.find((page) => page.slug === 'gallery-preset-trace').blocks[0].appearance.motionPreset, 'trace')
  assert.equal(value.pages.find((page) => page.slug === 'gallery-feature-grid-4').blocks.find((block) => block.type === 'featureGrid').items.length, 4)
  assert.equal(value.pages.find((page) => page.slug === 'gallery-section-services').template, 'landing')
  assert.match(galleryHash(value), /^[a-f0-9]{64}$/)
})

test('gallery library is a same-origin iframe controller with stable selection markers', () => {
  const html = galleryLibraryDocument({ title: 'Neutral', themeKey: 'starter@1.0.0', fixtureHash: 'a'.repeat(64), routes: { blocks: { hero: 'renders/base/index.html' }, templates: { landing: 'renders/base/index.html' }, backgrounds: [], presets: [], common: [] }, blocks: [{ id: 'hero', label: 'Hero', block: 'hero', route: 'renders/base/index.html' }], templates: [{ id: 'landing', label: 'Landing', route: 'renders/base/index.html' }], presets: [], extensions: [] })
  for (const marker of ['data-gallery-library', 'data-gallery-renderer', 'data-gallery-preview-kind', 'data-gallery-preview-id', 'data-gallery-empty-extensions']) assert.match(html, new RegExp(marker))
})
