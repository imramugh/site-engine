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
  ])('strict block fixture %s rejects unknown and raw CSS fields', (_name, valid) => { expect(BlockSchema.safeParse(valid).success).toBe(true); expect(BlockSchema.safeParse({ ...valid, unexpected: true }).success).toBe(false); expect(BlockSchema.safeParse({ ...valid, appearance: { ...appearance, background: '#fff' } }).success).toBe(false) })
})
