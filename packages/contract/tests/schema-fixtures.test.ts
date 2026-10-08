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
  it('requires usable media metadata, paired bounded focal coordinates, and exactly one business-case identity', () => { const media = { id, filename: 'neutral.webp', mimeType: 'image/webp', width: 10, height: 10, alt: 'Neutral image' }; expect(MediaReferenceSchema.safeParse(media).success).toBe(true); expect(MediaReferenceSchema.safeParse({ ...media, focalX: 28, focalY: 63 }).success).toBe(true); expect(MediaReferenceSchema.safeParse({ ...media, focalX: 28 }).success).toBe(false); expect(MediaReferenceSchema.safeParse({ ...media, focalX: -1, focalY: 63 }).success).toBe(false); expect(MediaReferenceSchema.safeParse({ ...media, focalX: 28.5, focalY: 63 }).success).toBe(false); expect(MediaReferenceSchema.safeParse({ ...media, alt: undefined }).success).toBe(false); expect(MediaReferenceSchema.safeParse({ ...media, width: undefined }).success).toBe(false); const business = { client: 'Neutral client', industry: 'Services', challenge: 'Challenge', approach: 'Approach', outcome: 'Outcome', services: ['Service'], publicationDate: '2026-01-01T00:00:00.000Z' }; expect(BusinessCaseSchema.safeParse(business).success).toBe(true); expect(BusinessCaseSchema.safeParse({ ...business, anonymizedClient: 'Also client' }).success).toBe(false); expect(BusinessCaseSchema.safeParse({ ...business, client: undefined }).success).toBe(false) })
  it('keeps old snapshots valid while gating captured focal points to contract 1.4', () => {
    const old = snapshot()
    expect(SiteSnapshotSchema.safeParse(old).success).toBe(true)
    old.media = [{ id, filename: 'neutral.webp', mimeType: 'image/webp', width: 10, height: 10, alt: 'Neutral image', decorative: false, focalX: 28, focalY: 63 }]
    expect(SiteSnapshotSchema.safeParse(old).success).toBe(false)
    old.settings.contractVersion = '1.4.0'
    expect(SiteSnapshotSchema.safeParse(old).success).toBe(true)
  })
  it('keeps type-specific page metadata on its supported templates', () => {
    const page = snapshot().pages[0]
    const reviewed = '2026-01-02T00:00:00.000Z'
    expect(PageSchema.safeParse({ ...page, template: 'service', kicker: 'Advisory', lede: 'A focused introduction.', lastReviewed: reviewed }).success).toBe(true)
    expect(PageSchema.safeParse({ ...page, kicker: 'Wrong template' }).success).toBe(false)
    expect(PageSchema.safeParse({ ...page, lastReviewed: reviewed }).success).toBe(false)
    const jobPosting = { datePosted: reviewed, employmentType: 'FULL_TIME', location: { addressLocality: 'Example City', addressCountry: 'CA' }, validThrough: '2026-02-02T00:00:00.000Z' }
    expect(JobPostingSchema.safeParse(jobPosting).success).toBe(true)
    for (const workMode of ['ONSITE', 'HYBRID', 'REMOTE']) expect(JobPostingSchema.safeParse({ ...jobPosting, workMode }).success).toBe(true)
    expect(JobPostingSchema.safeParse({ ...jobPosting, workMode: 'FLEXIBLE' }).success).toBe(false)
    expect(PageSchema.safeParse({ ...page, template: 'job', blocks: [], jobPosting }).success).toBe(true)
    expect(PageSchema.safeParse({ ...page, jobPosting }).success).toBe(false)
    const versioned = snapshot()
    versioned.settings = { ...versioned.settings, homepageId: undefined, sections: versioned.settings.sections.map((section) => ({ ...section, allowedTemplates: ['article' as const] })) }
    versioned.pages[0] = { ...page, template: 'article', blocks: [], lastReviewed: reviewed }
    versioned.settings.contractVersion = '1.3.0'
    expect(SiteSnapshotSchema.safeParse(versioned).success).toBe(false)
    versioned.settings.contractVersion = '1.4.0'
    expect(SiteSnapshotSchema.safeParse(versioned).success).toBe(true)
    const workModeSnapshot = snapshot()
    workModeSnapshot.settings.homepageId = undefined
    workModeSnapshot.settings.sections[0]!.allowedTemplates.push('job')
    workModeSnapshot.pages[0] = { ...page, template: 'job', blocks: [], jobPosting: { ...jobPosting, workMode: 'REMOTE' } }
    expect(SiteSnapshotSchema.safeParse(workModeSnapshot).success).toBe(false)
    workModeSnapshot.settings.contractVersion = '1.8.0'
    expect(SiteSnapshotSchema.safeParse(workModeSnapshot).success).toBe(true)
  })
  it('validates settings drafts and rejects unsupported snapshot contracts', () => { const value = snapshot(); expect(SiteSettingsSchema.safeParse(value.settings).success).toBe(true); expect(SiteSettingsDraftSchema.safeParse({ siteName: value.settings.siteName, defaultLocale: value.settings.defaultLocale }).success).toBe(true); expect(SiteSnapshotSchema.safeParse(value).success).toBe(true); expect(SiteSettingsSchema.safeParse({ ...value.settings, contractVersion: '2.0.0' }).success).toBe(false); expect(SiteSettingsDraftSchema.safeParse({ siteName: value.settings.siteName, defaultLocale: value.settings.defaultLocale, rawCss: '#fff' }).success).toBe(false); value.settings.contractVersion = '2.0.0' as never; expect(SiteSnapshotSchema.safeParse(value).success).toBe(false) })

  it('gates reviewed crawler policy to contract 1.7 without changing older snapshots', () => {
    const legacy = snapshot()
    legacy.settings.contractVersion = '1.6.0'
    expect(SiteSnapshotSchema.safeParse(legacy).success).toBe(true)
    legacy.settings.crawlerPolicy = { searchEngines: true, aiSearchAndAnswers: false, aiModelTraining: false }
    expect(SiteSnapshotSchema.safeParse(legacy).success).toBe(false)
    legacy.settings.contractVersion = '1.7.0'
    expect(SiteSnapshotSchema.safeParse(legacy).success).toBe(true)
    expect(SiteSettingsDraftSchema.safeParse({ siteName: 'Example', defaultLocale: 'en-CA', crawlerPolicy: legacy.settings.crawlerPolicy }).success).toBe(true)
    expect(SiteSettingsDraftSchema.safeParse({ siteName: 'Example', defaultLocale: 'en-CA', crawlerPolicy: { searchEngines: true, aiSearchAndAnswers: true } }).success).toBe(false)
  })
  it('keeps legacy settings valid while gating referenced site identity and navigation to 1.5', () => {
    const value = snapshot(); expect(SiteSnapshotSchema.safeParse(value).success).toBe(true)
    const logo = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'identity.svg', mimeType: 'image/svg+xml', width: 120, height: 60, alt: 'Synthetic identity', decorative: false }
    value.media.push(logo as never); value.settings.contractVersion = '1.5.0'
    Object.assign(value.settings, {
      legalName: 'Synthetic Studio Incorporated',
      address: { streetAddress: '100 Example Road', addressLocality: 'Example City', addressRegion: 'ON', postalCode: 'A1A 1A1', addressCountry: 'CA' },
      linkedIn: 'https://www.linkedin.com/company/synthetic-studio', incident: { label: 'Need urgent help?', guidance: 'Call the published incident line and preserve affected systems.' },
      logos: { primaryLight: logo }, navigation: { header: [{ kind: 'page', id: value.pages[0]!.id, label: 'Home', style: 'link' }], footer: { columns: [{ heading: 'Company', links: [{ kind: 'section', id: value.settings.sections[0]!.id, label: 'General' }] }], copyright: '© {year} Synthetic Studio Incorporated' } },
    })
    expect(SiteSnapshotSchema.safeParse(value).success).toBe(true)
    const legacy = structuredClone(value); legacy.settings.contractVersion = '1.4.0'; expect(SiteSnapshotSchema.safeParse(legacy).success).toBe(false)
    const missing = structuredClone(value); missing.settings.navigation!.header[0]!.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; expect(SiteSnapshotSchema.safeParse(missing).success).toBe(false)
  })
  it('gates unavailable, generated, contact, and bottom navigation to 1.6 while retaining literal copyright', () => {
    const value = snapshot(); value.settings.contractVersion = '1.6.0'
    value.settings.navigation = {
      header: [{ kind: 'unavailable', label: 'Insights', reason: 'Insights are planned but not published.', style: 'link' }],
      footer: {
        columns: [
          { kind: 'section-pillars', heading: 'Services', sectionId: value.settings.sections[0]!.id },
          { kind: 'contact', heading: 'Contact', fields: ['email', 'address', 'linkedIn'] },
        ],
        bottomLinks: [{ kind: 'unavailable', label: 'Privacy', reason: 'The privacy page is not published.' }],
        copyright: 'Copyright Synthetic Studio',
      },
    }
    expect(SiteSnapshotSchema.safeParse(value).success).toBe(true)
    const automatic = structuredClone(value); automatic.settings.navigation!.footer.copyright = '© {year} Synthetic Studio'; expect(SiteSnapshotSchema.safeParse(automatic).success).toBe(true)
    const unknownToken = structuredClone(value); unknownToken.settings.navigation!.footer.copyright = '© {date} Synthetic Studio'; expect(SiteSnapshotSchema.safeParse(unknownToken).success).toBe(false)
    const duplicateContact = structuredClone(value); duplicateContact.settings.navigation!.footer.columns[1] = { kind: 'contact', heading: 'Contact', fields: ['email', 'email'] }; expect(SiteSnapshotSchema.safeParse(duplicateContact).success).toBe(false)
    const old = structuredClone(value); old.settings.contractVersion = '1.5.0'; expect(SiteSnapshotSchema.safeParse(old).success).toBe(false)
  })
})
