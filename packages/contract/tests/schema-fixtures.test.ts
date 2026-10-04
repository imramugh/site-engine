import { describe, expect, it } from 'vitest'
import { AppearanceSchema, BlockSchema, ChangeSetSchema, RedirectSchema, StyleGuideSchema, ThemeInstallSchema, ThemeManifestSchema, ThemeSelectionSchema } from '../src/index.js'
const id = '11111111-1111-4111-8111-111111111111'
const appearance = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' }
const block = { id, hidden: false, type: 'cta' as const, heading: 'Continue', body: 'Neutral content.', cta: { label: 'Read', href: '/read' }, appearance }

describe('ENG-002 exported schema fixtures', () => {
  it.each([
    ['appearance', AppearanceSchema, appearance, { ...appearance, background: '#fff' }],
    ['theme selection', ThemeSelectionSchema, { id: 'neutral', version: '1.0.0', contract: '1.0.0', manifestDigest: 'a'.repeat(64) }, { id: 'neutral', version: 'latest', contract: '1.0.0', manifestDigest: 'a'.repeat(64) }],
    ['redirect', RedirectSchema, { from: '/from', to: '/to', status: 301 }, { from: '//external', to: '/to', status: 301 }],
    ['change set', ChangeSetSchema, { id, name: 'Neutral change', state: 'open', revision: 0 }, { id, name: 'Neutral change', state: 'unknown', revision: 0 }],
    ['style guide', StyleGuideSchema, { canadianSpelling: 'warn', maximumSentenceWords: 20 }, { canadianSpelling: 'warn', maximumSentenceWords: 2 }],
    ['theme manifest', ThemeManifestSchema, { name: 'neutral', version: '1.0.0', contract: '1.0.0', entry: './dist/index.js' }, { name: 'neutral', version: '1.0.0', contract: '1.0.0', entry: '../index.js' }],
    ['theme install compatibility', ThemeInstallSchema, { manifest: { name: 'neutral', version: '1.0.0', contract: '1.0.0', entry: './dist/index.js' }, installedAt: '2026-01-01T00:00:00.000Z' }, { manifest: { name: 'neutral', version: '1.0.0', contract: '2.0.0', entry: './dist/index.js' }, installedAt: '2026-01-01T00:00:00.000Z' }],
  ])('%s accepts valid and rejects invalid fixture', (_name, schema, valid, invalid) => { expect(schema.safeParse(valid).success).toBe(true); expect(schema.safeParse(invalid).success).toBe(false) })
  it.each([
    ['cta', block],
    ['hero', { ...block, type: 'hero', heading: 'Hero', body: 'Neutral hero.' }],
    ['faq', { id, hidden: false, type: 'faq', heading: 'Questions', items: [{ question: 'Question?', answer: 'Answer.' }], appearance }],
    ['media', { id, hidden: false, type: 'media', mediaId: id, appearance }],
    ['incidentBar', { id, hidden: false, type: 'incidentBar', message: 'Notice', appearance }],
    ['pillarGrid', { id, hidden: false, type: 'pillarGrid', heading: 'Pillars', items: [{ title: 'One', body: 'Body', href: '/one' }], appearance }],
    ['featureGrid', { id, hidden: false, type: 'featureGrid', heading: 'Features', items: [{ title: 'One', body: 'Body' }], appearance }],
    ['splitList', { id, hidden: false, type: 'splitList', heading: 'List', items: [{ title: 'One', body: 'Body' }], appearance }],
    ['chipList', { id, hidden: false, type: 'chipList', chips: ['One'], appearance }],
    ['testimonials', { id, hidden: false, type: 'testimonials', items: [{ quote: 'Quote', attribution: 'Person', permissionConfirmed: true }], appearance }],
    ['callout', { id, hidden: false, type: 'callout', heading: 'Callout', body: 'Body', appearance }],
    ['relatedServices', { id, hidden: false, type: 'relatedServices', heading: 'Related', pageIds: [id], appearance }],
    ['richText', { id, hidden: false, type: 'richText', body: 'Body', appearance }],
    ['contact', { id, hidden: false, type: 'contact', heading: 'Contact', body: 'Body', appearance }],
    ['imageText', { id, hidden: false, type: 'imageText', heading: 'Image', body: 'Body', mediaId: id, appearance }],
    ['gallery', { id, hidden: false, type: 'gallery', mediaIds: [id], appearance }],
    ['logoStrip', { id, hidden: false, type: 'logoStrip', mediaIds: [id], appearance }],
    ['video', { id, hidden: false, type: 'video', mediaId: id, posterMediaId: id, captionsMediaId: id, appearance }],
  ])('strict block fixture %s rejects unknown and raw CSS fields', (_name, valid) => { expect(BlockSchema.safeParse(valid).success).toBe(true); expect(BlockSchema.safeParse({ ...valid, type: undefined }).success).toBe(false); expect(BlockSchema.safeParse({ ...valid, unexpected: true }).success).toBe(false); expect(BlockSchema.safeParse({ ...valid, appearance: { ...appearance, background: '#fff' } }).success).toBe(false) })
})
