import { describe, expect, it } from 'vitest';
import {
  BlockSchema, PageSchema, SiteSnapshotSchema, ThemeInstallSchema,
  ThemeManifestSchema, SectionPresets, compatibleContractVersion, formatSnapshotValidationError,
  InlineTextFieldPolicy, isInlineTextTarget,
} from '../src/index.js';
import { neutralFixture } from '../src/fixtures.js';

const blockId = '33333333-3333-4333-8333-333333333333';
const appearance = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none' };
const cta = { id: blockId, type: 'cta', heading: 'Next steps', body: 'Read more.', cta: { label: 'Read', href: '/guide' }, appearance };
const fixture = () => structuredClone(neutralFixture);

describe('ENG-002 versioned contract', () => {
  it('keeps inline text editing to the explicit rendered scalar policy', () => {
    expect(InlineTextFieldPolicy).toEqual({ hero: ['eyebrow', 'heading', 'body'], callout: ['heading', 'body'], cta: ['heading', 'body'] });
    expect(isInlineTextTarget({ type: 'hero' }, 'heading')).toBe(true);
    expect(isInlineTextTarget({ type: 'hero' }, 'cta')).toBe(false);
    expect(isInlineTextTarget({ type: 'callout' }, 'body')).toBe(true);
    expect(isInlineTextTarget({ type: 'cta' }, 'href')).toBe(false);
    expect(isInlineTextTarget({ type: 'faq' }, 'heading')).toBe(false);
    expect(isInlineTextTarget({ type: 'hero' }, 'items.0.title')).toBe(false);
    expect(isInlineTextTarget({ type: 'constructor' }, 'heading')).toBe(false);
    expect(isInlineTextTarget({ type: 'toString' }, 'heading')).toBe(false);
  });
  it('accepts the neutral legacy snapshot and only supported contract versions', () => {
    expect(SiteSnapshotSchema.safeParse(neutralFixture).success).toBe(true);
    expect(compatibleContractVersion('1.0.0')).toBe(true);
    expect(compatibleContractVersion('1.1.0')).toBe(true);
    expect(compatibleContractVersion('1.2.0')).toBe(true);
    expect(compatibleContractVersion('1.3.0')).toBe(true);
    expect(compatibleContractVersion('1.4.0')).toBe(true);
    expect(compatibleContractVersion('1.5.0')).toBe(true);
    expect(compatibleContractVersion('2.0.0')).toBe(false);
    expect(compatibleContractVersion('1.0.0-beta')).toBe(false);
    expect(ThemeInstallSchema.safeParse({ manifest: { name: 'neutral', version: '1.0.0', contract: '1.1.0', entry: './dist/index.js' }, installedAt: '2026-01-01T00:00:00.000Z' }).success).toBe(true);
  });

  it('names invalid page blocks without serializing their content', () => {
    const snapshot = fixture();
    const page = snapshot.pages[0]!;
    const block = page.blocks[0]!;
    if (block.type !== 'hero') throw new Error('Fixture must begin with a hero.');
    block.heading = '';
    const parsed = SiteSnapshotSchema.safeParse(snapshot);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const diagnostic = formatSnapshotValidationError(snapshot, parsed.error);
    expect(diagnostic).toContain(`page \"${page.title}\" (${page.id}), block hero (${block.id})`);
    expect(diagnostic).toContain('pages[0].blocks[0].heading');
    expect(diagnostic).not.toContain(block.body);
  });

  it('accepts legacy published snapshots without SEO timestamps', () => {
    const legacy = fixture();
    delete legacy.pages[0].publishedAt;
    delete legacy.pages[0].updatedAt;
    expect(SiteSnapshotSchema.safeParse(legacy).success).toBe(true);
  });

  it('keeps legacy parsed snapshots byte-for-byte stable while gating new optional content to 1.2', () => {
    const legacy = fixture();
    expect(SiteSnapshotSchema.parse(legacy)).toEqual(legacy);
    const page = legacy.pages[0]!;
    page.blocks.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'featureGrid', eyebrow: 'Optional context', heading: 'Options', body: 'Neutral introductory copy.', items: [{ title: 'One', body: 'One neutral option.' }], hidden: false, appearance } as never);
    expect(SiteSnapshotSchema.safeParse(legacy).success).toBe(false);
    legacy.settings.contractVersion = '1.2.0';
    expect(SiteSnapshotSchema.safeParse(legacy).success).toBe(true);
  });

  it('requires contract 1.2 for link fragments while preserving existing paths', () => {
    const legacy = fixture();
    const hero = legacy.pages[0]!.blocks[0]!;
    if (hero.type !== 'hero') throw new Error('Fixture must begin with a hero.');
    hero.cta = { label: 'Jump to details', href: '/#details' };
    expect(SiteSnapshotSchema.safeParse(legacy).success).toBe(false);
    legacy.settings.contractVersion = '1.2.0';
    expect(SiteSnapshotSchema.safeParse(legacy).success).toBe(true);
    const legacyWithEmptyLinks = fixture();
    legacyWithEmptyLinks.pages[0]!.blocks.push({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', type: 'pillarGrid', heading: 'Options', items: [{ title: 'One', body: 'One neutral option.', href: '/', links: [] }], hidden: false, appearance } as never);
    expect(SiteSnapshotSchema.safeParse(legacyWithEmptyLinks).success).toBe(false);
  });

  it('gates bounded contact details to contract 1.3 with safe channel hrefs', () => {
    const snapshot = fixture();
    const contactPage = structuredClone(snapshot.pages[0]!);
    contactPage.id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    contactPage.slug = 'contact';
    contactPage.template = 'standard';
    contactPage.blocks = [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', type: 'contact', heading: 'Contact', body: 'Neutral contact information.', inquiryForm: true, contactDetails: { incidentCallout: { label: 'Urgent contact', body: 'Use the listed contact method for urgent matters.', phoneLabel: 'Call now' }, channels: [{ kind: 'phone', label: 'Phone', value: '+1 555 0123', href: 'tel:+15550123' }, { kind: 'email', label: 'Email', value: 'contact@example.test', href: 'mailto:contact@example.test' }, { kind: 'address', label: 'Address', value: 'Example address' }, { kind: 'link', label: 'Profile', value: 'Example profile', href: 'https://example.test/profile' }], nextStepsHeading: 'Next steps', nextSteps: [{ title: 'Review', body: 'We review the inquiry.' }] }, hidden: false, appearance } as never];
    snapshot.settings.sections[0]!.allowedTemplates.push('standard');
    snapshot.settings.sections[0]!.pageIds.push(contactPage.id);
    snapshot.pages.push(contactPage);
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(false);
    snapshot.settings.contractVersion = '1.3.0';
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(true);
    const contact = contactPage.blocks[0]!;
    expect(BlockSchema.safeParse({ ...contact, contactDetails: { ...contact.contactDetails!, channels: [{ kind: 'link', label: 'Unsafe', value: 'Unsafe link', href: 'https://user@example.test/' }] } }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...contact, contactDetails: { ...contact.contactDetails!, channels: [{ kind: 'address', label: 'Address', value: 'Address', href: 'https://example.test/' }] } }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...contact, contactDetails: { ...contact.contactDetails!, channels: [{ kind: 'email', label: 'Email', value: 'Contact', href: 'mailto:contact@example.test?bcc=other@example.test' }] } }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...contact, contactDetails: { ...contact.contactDetails!, channels: [{ kind: 'link', label: 'Link', value: 'Contact', href: 'https://example.test/%0d%0aheader' }] } }).success).toBe(false);
  });

  it('accepts bounded inquiry presentation while rejecting duplicate topics and copy without a form', () => {
    const contact = { id: blockId, type: 'contact' as const, heading: 'Contact', body: 'Send an inquiry.', inquiryForm: true, inquiryTopicLabel: 'What can we help with?', inquiryTopics: [{ value: 'consultation' as const, label: 'Consultation' }, { value: 'active-incident' as const, label: 'Active incident' }], inquiryConsentLabel: 'You can contact me about this inquiry.', appearance };
    expect(BlockSchema.safeParse(contact).success).toBe(true);
    expect(BlockSchema.safeParse({ ...contact, inquiryTopics: [...contact.inquiryTopics, { value: 'consultation', label: 'Another consultation' }] }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...contact, inquiryTopics: Array.from({ length: 13 }, (_, index) => ({ value: index ? 'general' : 'consultation', label: `Topic ${index}` })) }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...contact, inquiryForm: false }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...contact, inquiryTopics: [{ value: 'unsupported', label: 'Unsupported' }] }).success).toBe(false);
    const snapshot = fixture(); const contactPage = { ...structuredClone(snapshot.pages[0]!), id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', slug: 'inquiry', template: 'standard' as const, blocks: [contact as never] };
    snapshot.settings.sections[0]!.allowedTemplates.push('standard'); snapshot.settings.sections[0]!.pageIds.push(contactPage.id); snapshot.pages.push(contactPage);
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(false);
    snapshot.settings.contractVersion = '1.5.0';
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('accepts bounded structured service links and rejects unsafe fragments', () => {
    const page = fixture().pages[0]!;
    const pillar = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'pillarGrid' as const, heading: 'Pillars', items: [{ title: 'One', body: 'Neutral detail.', href: '/services#details', links: [{ label: 'Details', href: '/services#details' }] }], hidden: false, appearance };
    expect(BlockSchema.safeParse(pillar).success).toBe(true);
    expect(BlockSchema.safeParse({ ...pillar, items: [{ ...pillar.items[0], links: Array.from({ length: 13 }, () => ({ label: 'Details', href: '/services#details' })) }] }).success).toBe(false);
    for (const href of ['/services?query=1', '/services#bad%20anchor', '//services#details', '/services#Details']) expect(BlockSchema.safeParse({ ...pillar, items: [{ ...pillar.items[0], links: [{ label: 'Unsafe', href }] }] }).success).toBe(false);
    const related = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', type: 'relatedServices' as const, heading: 'Related', pageIds: [], links: [{ label: 'Service detail', href: '/services#details' }], hidden: false, appearance };
    expect(BlockSchema.safeParse(related).success).toBe(true);
    expect(BlockSchema.safeParse({ ...related, links: [{ label: 'One', href: '/one' }, { label: 'Two', href: '/two' }, { label: 'Three', href: '/three' }, { label: 'Four', href: '/four' }] }).success).toBe(false);
    expect(PageSchema.safeParse(page).success).toBe(true);
  });

  it('rejects unknown appearance fields without confusing escaped prose with styling', () => {
    expect(BlockSchema.safeParse({ ...cta, colour: '#fff' }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...cta, appearance: { ...appearance, background: '#fff' } }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...cta, heading: 'Choosing a background: a guide' }).success).toBe(true);
    expect(BlockSchema.safeParse({ ...cta, heading: 'A title\u0000' }).success).toBe(false);
  });

  it.each(['//evil.example/path', '/\\evil.example', '/path\n', 'javascript:alert(1)'])('rejects unsafe link %s', (href) => {
    expect(BlockSchema.safeParse({ ...cta, cta: { label: 'Read', href } }).success).toBe(false);
  });

  it('requires contract 1.1.0 for optional hero supporting content while preserving legacy heroes', () => {
    const legacy = { id: blockId, type: 'hero' as const, heading: 'A clear heading', body: 'A clear body.', appearance };
    const enhanced = {
      ...legacy,
      secondaryCta: { label: 'Compare options', href: '/options' },
      supportPanel: { eyebrow: 'Helpful context', heading: 'Before you begin', body: 'Review the neutral supporting information.', cta: { label: 'Read details', href: '/details' }, phoneCta: { label: 'Call the team', number: '+15551234567' } },
    };
    expect(BlockSchema.safeParse(legacy).success).toBe(true);
    expect(BlockSchema.safeParse(enhanced).success).toBe(true);
    expect(BlockSchema.safeParse({ ...enhanced, secondaryCta: { label: 'Unsafe', href: 'javascript:alert(1)' } }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...enhanced, supportPanel: { ...enhanced.supportPanel, cta: { label: 'Unsafe', href: '//evil.example/path' } } }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...enhanced, supportPanel: { ...enhanced.supportPanel, phoneCta: { label: 'Unsafe', number: 'tel:+15551234567' } } }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...enhanced, supportPanel: { ...enhanced.supportPanel, phoneCta: { label: 'Unsafe', number: 'javascript:alert(1)' } } }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...enhanced, supportPanel: { ...enhanced.supportPanel, phoneCta: { label: 'Too short', number: '+1555' } } }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...enhanced, supportPanel: { heading: '', body: 'Missing heading.' } }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...enhanced, supportPanel: { ...enhanced.supportPanel, extra: '<script>alert(1)</script>' } }).success).toBe(false);
    const legacySnapshot = fixture();
    const legacyHero = legacySnapshot.pages[0]!.blocks[0]!;
    if (legacyHero.type !== 'hero') throw new Error('Fixture must begin with a hero.');
    legacyHero.secondaryCta = enhanced.secondaryCta;
    expect(SiteSnapshotSchema.safeParse(legacySnapshot).success).toBe(false);
    const currentSnapshot = structuredClone(legacySnapshot);
    currentSnapshot.settings.contractVersion = '1.1.0';
    expect(SiteSnapshotSchema.safeParse(currentSnapshot).success).toBe(true);
  });

  it('requires a selected theme to declare the exact snapshot contract', () => {
    const snapshot = fixture();
    snapshot.settings.contractVersion = '1.1.0';
    snapshot.settings.theme = { id: 'neutral', version: '1.1.0', contract: '1.0.0', manifestDigest: 'a'.repeat(64) };
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(false);
    snapshot.settings.theme.contract = '1.1.0';
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('requires testimonial permission to be recorded, while allowing unapproved drafts', () => {
    const testimonial = { id: blockId, type: 'testimonials', appearance, items: [{ quote: 'Synthetic quote', attribution: 'Example Person' }] };
    expect(BlockSchema.safeParse(testimonial).success).toBe(false);
    expect(BlockSchema.safeParse({ ...testimonial, items: [{ ...testimonial.items[0], permissionConfirmed: false }] }).success).toBe(true);
  });

  it('enforces background-video limits separately from content-video captions', () => {
    const backgroundVideo = { mediaId: blockId, posterMediaId: blockId, durationSeconds: 15, bytes: 3_000_000 };
    expect(BlockSchema.safeParse({ ...cta, appearance: { ...appearance, backgroundVideo } }).success).toBe(true);
    expect(BlockSchema.safeParse({ ...cta, appearance: { ...appearance, backgroundVideo: { ...backgroundVideo, bytes: 3_000_001 } } }).success).toBe(false);
    expect(BlockSchema.safeParse({ ...cta, type: 'contact', cta: undefined, appearance: { ...appearance, backgroundVideo } }).success).toBe(false);
    const video = { id: blockId, type: 'video', appearance, mediaId: blockId, posterMediaId: blockId };
    expect(BlockSchema.safeParse(video).success).toBe(false);
    expect(BlockSchema.safeParse({ ...video, captionsMediaId: blockId }).success).toBe(true);
  });

  it('rejects manifest traversal instead of loading code outside the package', () => {
    expect(ThemeManifestSchema.safeParse({ name: 'neutral', version: '1.0.0', contract: '1.0.0', entry: './dist/../../private.js' }).success).toBe(false);
  });

  it('accepts declared theme motion presets and intent fallbacks', () => {
    const manifest = { name: 'neutral', version: '1.0.0', contract: '1.0.0', entry: './dist/index.js', motion: { presets: ['fade'], intentFallbacks: { subtle: 'fade' } } };
    expect(ThemeManifestSchema.safeParse(manifest).success).toBe(true);
    expect(ThemeManifestSchema.safeParse({ ...manifest, motion: { ...manifest.motion, intentFallbacks: { subtle: 'invalid preset' } } }).success).toBe(false);
    expect(ThemeManifestSchema.safeParse({ ...manifest, motion: { ...manifest.motion, presets: ['fade', 'fade'] } }).success).toBe(false);
    expect(ThemeManifestSchema.safeParse({ ...manifest, motion: { ...manifest.motion, intentFallbacks: { none: 'fade' } } }).success).toBe(false);
  });

  it('requires summaries, a visible landing hero, and compatible blocks', () => {
    const page = neutralFixture.pages[0];
    expect(PageSchema.safeParse({ ...page, summary: undefined }).success).toBe(false);
    expect(PageSchema.safeParse({ ...page, blocks: [] }).success).toBe(false);
    expect(PageSchema.safeParse({ ...page, template: 'job' }).success).toBe(false);
    expect(PageSchema.safeParse({ ...page, template: 'listing', blocks: [cta] }).success).toBe(true);
  });
});

describe('ENG-003 content tree validation', () => {
  it('defines the root, services, insights, careers, and future section template presets', () => {
    expect(SectionPresets).toEqual({
      root: ['landing', 'standard'],
      services: ['landing', 'pillar', 'service'],
      insights: ['listing', 'article'],
      careers: ['listing', 'job'],
      future: ['landing', 'standard', 'article'],
      landing: ['landing', 'standard', 'article'],
    });
  });

  it('rejects unknown section references and templates outside a section allowlist', () => {
    const snapshot = fixture();
    snapshot.pages[0].sectionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(false);
    const disallowed = fixture();
    disallowed.settings.sections[0].allowedTemplates = ['standard'];
    expect(SiteSnapshotSchema.safeParse(disallowed).success).toBe(false);
  });

  it('detects ancestry cycles and repeated page identifiers', () => {
    const snapshot = fixture();
    snapshot.pages[0].parentId = snapshot.pages[0].id;
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(false);
    const duplicates = fixture();
    duplicates.pages.push({ ...duplicates.pages[0] });
    expect(SiteSnapshotSchema.safeParse(duplicates).success).toBe(false);
  });

  it('rejects a fourth tree level and allows a three-level tree', () => {
    const snapshot = fixture();
    const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
    snapshot.settings.sections[0].allowedTemplates.push('standard');
    for (let i = 0; i < 2; i++) snapshot.pages.push({ ...snapshot.pages[0], id: ids[i], slug: `page-${i}`, template: 'standard', parentId: snapshot.pages.at(-1)!.id });
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(true);
    snapshot.pages.push({ ...snapshot.pages[0], id: ids[2], slug: 'page-three', template: 'standard', parentId: ids[1] });
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it('requires a service parent to be a pillar', () => {
    const snapshot = fixture();
    snapshot.pages.push({ ...snapshot.pages[0], id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'service', template: 'service', parentId: snapshot.pages[0].id });
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it('accepts complete article business cases and rejects ambiguous or incompatible metadata', () => {
    const snapshot = fixture(); const page = { ...snapshot.pages[0]!, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'case-study', title: 'Synthetic case study', template: 'article' as const, blocks: [{ id: blockId, type: 'richText' as const, body: 'A valid synthetic article body.', appearance }] };
    snapshot.pages.push(page); snapshot.settings.sections[0]!.pageIds.push(page.id); snapshot.settings.sections[0]!.allowedTemplates.push('article');
    page.businessCase = { client: 'Sample client', industry: 'Services', challenge: 'A clear synthetic challenge.', approach: 'A clear synthetic approach.', outcome: 'A clear synthetic outcome.', services: ['Strategy'], publicationDate: '2026-10-03T12:00:00.000Z' };
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(true);
    page.businessCase = { ...page.businessCase, anonymizedClient: 'Anonymous' };
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(false);
    page.businessCase = { ...page.businessCase, client: undefined, anonymizedClient: 'Anonymous' }; page.template = 'standard'; snapshot.settings.sections[0]!.allowedTemplates.push('standard');
    expect(SiteSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
});
