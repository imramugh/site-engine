import { describe, expect, it } from 'vitest'
import { neutralFixture } from '../src/fixtures.js'
import { AppearanceSchema, BackgroundSchema, BlockSchema, ChangeSetStateSchema, ContractVersionSchema, JobPostingSchema, LinkSchema, LogoToneSchema, MotionIntentSchema, PhoneCtaSchema, SpacingSchema, TemplateSchema, WidthSchema, BusinessCaseSchema, ChangeSetSchema, MediaReferenceSchema, PageSchema, SectionSchema, SiteSettingsDraftSchema, SiteSettingsSchema, SiteSnapshotSchema, RedirectSchema, StyleGuideSchema, ThemeInstallSchema, ThemeManifestSchema, ThemeSelectionSchema } from '../src/index.js'
const id = '11111111-1111-4111-8111-111111111111'
const appearance = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' }
const block = { id, hidden: false, type: 'cta' as const, heading: 'Continue', body: 'Neutral content.', cta: { label: 'Read', href: '/read' }, appearance }

describe('ENG-002 exported schema fixtures', () => {
  it.each([
    ['contract version', ContractVersionSchema, '1.2.0', '2.0.0'],
    ...['default', 'subtle', 'brand', 'accent', 'highlight', 'inverse'].map(value => [`background ${value}`, BackgroundSchema, value, 'raw-css']),
    ['width', WidthSchema, 'wide', 'raw'], ['spacing', SpacingSchema, 'spacious', 'raw'], ['motion', MotionIntentSchema, 'ambient', 'raw'], ['logo tone', LogoToneSchema, 'inverse', 'raw'],
    ['template', TemplateSchema, 'service', 'raw'], ['change state', ChangeSetStateSchema, 'published', 'raw'],
    ['link', LinkSchema, { label: 'Neutral', href: '/neutral#details' }, { label: 'Neutral', href: '/neutral?query=1' }],
    ['phone', PhoneCtaSchema, { label: 'Call', number: '+14165550123' }, { label: 'Call', number: '4165550123' }],
  ])('%s accepts valid and rejects invalid fixture', (_name, schema, valid, invalid) => { expect(schema.safeParse(valid).success).toBe(true); expect(schema.safeParse(invalid).success).toBe(false) })
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


describe('ENG-002 site data semantic fixtures', () => {
  const snapshot = () => structuredClone(neutralFixture)
  it('validates pages and sections while rejecting template and hierarchy errors', () => { const page = snapshot().pages[0]; expect(PageSchema.safeParse(page).success).toBe(true); expect(PageSchema.safeParse({ ...page, template: 'job' }).success).toBe(false); const section = snapshot().settings.sections[0]; expect(SectionSchema.safeParse(section).success).toBe(true); expect(SectionSchema.safeParse({ ...section, allowedTemplates: [] }).success).toBe(false) })
  it('requires usable media metadata and exactly one business-case identity', () => { const media = { id, filename: 'neutral.webp', mimeType: 'image/webp', width: 10, height: 10, alt: 'Neutral image' }; expect(MediaReferenceSchema.safeParse(media).success).toBe(true); expect(MediaReferenceSchema.safeParse({ ...media, alt: undefined }).success).toBe(false); expect(MediaReferenceSchema.safeParse({ ...media, width: undefined }).success).toBe(false); const business = { client: 'Neutral client', industry: 'Services', challenge: 'Challenge', approach: 'Approach', outcome: 'Outcome', services: ['Service'], publicationDate: '2026-01-01T00:00:00.000Z' }; expect(BusinessCaseSchema.safeParse(business).success).toBe(true); expect(BusinessCaseSchema.safeParse({ ...business, anonymizedClient: 'Also client' }).success).toBe(false); expect(BusinessCaseSchema.safeParse({ ...business, client: undefined }).success).toBe(false) })
  it('keeps type-specific page metadata on its supported templates', () => {
    const page = snapshot().pages[0]
    const reviewed = '2026-01-02T00:00:00.000Z'
    expect(PageSchema.safeParse({ ...page, template: 'service', kicker: 'Advisory', lede: 'A focused introduction.', lastReviewed: reviewed }).success).toBe(true)
    expect(PageSchema.safeParse({ ...page, kicker: 'Wrong template' }).success).toBe(false)
    expect(PageSchema.safeParse({ ...page, lastReviewed: reviewed }).success).toBe(false)
    const jobPosting = { datePosted: reviewed, employmentType: 'FULL_TIME', location: { addressLocality: 'Example City', addressCountry: 'CA' }, validThrough: '2026-02-02T00:00:00.000Z' }
    expect(JobPostingSchema.safeParse(jobPosting).success).toBe(true)
    expect(PageSchema.safeParse({ ...page, template: 'job', blocks: [], jobPosting }).success).toBe(true)
    expect(PageSchema.safeParse({ ...page, jobPosting }).success).toBe(false)
    const versioned = snapshot()
    versioned.settings = { ...versioned.settings, homepageId: undefined, sections: versioned.settings.sections.map((section) => ({ ...section, allowedTemplates: ['article' as const] })) }
    versioned.pages[0] = { ...page, template: 'article', blocks: [], lastReviewed: reviewed }
    versioned.settings.contractVersion = '1.3.0'
    expect(SiteSnapshotSchema.safeParse(versioned).success).toBe(false)
    versioned.settings.contractVersion = '1.4.0'
    expect(SiteSnapshotSchema.safeParse(versioned).success).toBe(true)
  })
  it('validates settings drafts and rejects unsupported snapshot contracts', () => { const value = snapshot(); expect(SiteSettingsSchema.safeParse(value.settings).success).toBe(true); expect(SiteSettingsDraftSchema.safeParse({ siteName: value.settings.siteName, defaultLocale: value.settings.defaultLocale }).success).toBe(true); expect(SiteSnapshotSchema.safeParse(value).success).toBe(true); expect(SiteSettingsSchema.safeParse({ ...value.settings, contractVersion: '2.0.0' }).success).toBe(false); expect(SiteSettingsDraftSchema.safeParse({ siteName: value.settings.siteName, defaultLocale: value.settings.defaultLocale, rawCss: '#fff' }).success).toBe(false); value.settings.contractVersion = '2.0.0' as never; expect(SiteSnapshotSchema.safeParse(value).success).toBe(false) })
})
