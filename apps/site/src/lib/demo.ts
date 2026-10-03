import { SiteSnapshotSchema, type SiteSnapshot } from '@site-engine/contract';

const ids = { rootSection: '10000000-0000-4000-8000-000000000001', serviceSection: '10000000-0000-4000-8000-000000000002', insightSection: '10000000-0000-4000-8000-000000000003', careerSection: '10000000-0000-4000-8000-000000000004', home: '20000000-0000-4000-8000-000000000001', guide: '20000000-0000-4000-8000-000000000002', gallery: '20000000-0000-4000-8000-000000000003', pillar: '20000000-0000-4000-8000-000000000004', service: '20000000-0000-4000-8000-000000000005', article: '20000000-0000-4000-8000-000000000006', listing: '20000000-0000-4000-8000-000000000007', job: '20000000-0000-4000-8000-000000000008', image: '30000000-0000-4000-8000-000000000001', logo: '30000000-0000-4000-8000-000000000002', video: '30000000-0000-4000-8000-000000000003', poster: '30000000-0000-4000-8000-000000000004', captions: '30000000-0000-4000-8000-000000000005' };
const appearance = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' };
const block = (id: string, type: string, fields: object, tone = appearance) => ({ id, type, hidden: false, appearance: tone, ...fields });

/** Public, synthetic content only. It deliberately exercises every standard block. */
export const demoSnapshot: SiteSnapshot = SiteSnapshotSchema.parse({
  settings: { contractVersion: '1.0.0', siteName: 'Sample Studio', defaultLocale: 'en', homepageId: ids.home, sections: [
    { id: ids.rootSection, name: 'General', summary: 'Neutral publishing examples.', slug: 'general', allowedTemplates: ['landing', 'standard', 'article'], pageIds: [ids.home, ids.guide, ids.gallery, ids.article] },
    { id: ids.serviceSection, name: 'Services', summary: 'Generic service hierarchy.', slug: 'services', allowedTemplates: ['landing', 'pillar', 'service'], pageIds: [ids.pillar, ids.service] },
    { id: ids.insightSection, name: 'Insights', summary: 'Generic listing hierarchy.', slug: 'insights', allowedTemplates: ['listing', 'article'], pageIds: [ids.listing] },
    { id: ids.careerSection, name: 'Careers', summary: 'Generic job hierarchy.', slug: 'careers', allowedTemplates: ['listing', 'job'], pageIds: [ids.job] },
  ] },
  pages: [
    { id: ids.home, sectionId: ids.rootSection, title: 'A neutral publishing example', summary: 'A synthetic home page that demonstrates generic rendering.', slug: 'home', template: 'landing', status: 'published', blocks: [block('40000000-0000-4000-8000-000000000001', 'hero', { eyebrow: 'Sample Studio', heading: 'Publish clear information', body: 'This synthetic demonstration contains no client data.', cta: { label: 'Read the guide', href: '/general/guide' } }, { ...appearance, spacing: 'spacious', motionIntent: 'subtle' }), block('40000000-0000-4000-8000-000000000002', 'featureGrid', { heading: 'Reusable building blocks', items: [{ title: 'Structured', body: 'Content has a stable schema.' }, { title: 'Accessible', body: 'Semantics are part of the baseline.' }] }, { ...appearance, background: 'subtle', motionIntent: 'ambient' })] },
    { id: ids.guide, sectionId: ids.rootSection, title: 'Guide', summary: 'A real destination for the example call to action.', slug: 'guide', template: 'standard', status: 'published', blocks: [block('40000000-0000-4000-8000-000000000003', 'richText', { body: 'This guide is neutral sample content. It exists so the home page call to action has a valid destination.' })] },
    { id: ids.gallery, sectionId: ids.rootSection, title: 'Block gallery', summary: 'Every standard block rendered with neutral fixture data.', slug: 'gallery', template: 'standard', status: 'published', blocks: [
      block('40000000-0000-4000-8000-000000000004', 'incidentBar', { message: 'Sample status information is shown here.', cta: { label: 'Read the guide', href: '/general/guide' } }, { ...appearance, background: 'highlight', motionIntent: 'signature' }),
      block('40000000-0000-4000-8000-000000000005', 'pillarGrid', { heading: 'Pillars', items: [{ title: 'One', body: 'First neutral pillar.', href: '/services/operations' }, { title: 'Two', body: 'Second neutral pillar.', href: '/general/guide' }] }),
      block('40000000-0000-4000-8000-000000000006', 'featureGrid', { heading: 'Features', items: [{ title: 'Short', body: 'Short copy.' }, { title: 'Long', body: 'Longer synthetic copy demonstrates a resilient card layout without depending on a real client message.' }] }),
      block('40000000-0000-4000-8000-000000000007', 'splitList', { heading: 'Steps', items: [{ title: 'Discover', body: 'Understand the stated problem.' }, { title: 'Publish', body: 'Present the approved material clearly.' }] }),
      block('40000000-0000-4000-8000-000000000008', 'chipList', { heading: 'Topics', chips: ['Access', 'Structure', 'Clarity'] }),
      block('40000000-0000-4000-8000-000000000009', 'testimonials', { items: [{ quote: 'A synthetic quote for renderer coverage.', attribution: 'Sample contributor', role: 'Example role', permissionConfirmed: true }, { quote: 'This unconfirmed quote must not render.', attribution: 'Excluded source', permissionConfirmed: false }] }),
      block('40000000-0000-4000-8000-000000000010', 'faq', { heading: 'Questions', items: [{ question: 'Is this content real?', answer: 'No. It is neutral fixture content.' }, { question: 'Is the markup accessible?', answer: 'The fixture uses native disclosure controls.' }] }),
      block('40000000-0000-4000-8000-000000000011', 'callout', { heading: 'A useful callout', body: 'This is a plain text message.', cta: { label: 'Open the guide', href: '/general/guide' } }, { ...appearance, background: 'accent' }),
      block('40000000-0000-4000-8000-000000000012', 'relatedServices', { heading: 'Related services', pageIds: [ids.service] }),
      block('40000000-0000-4000-8000-000000000013', 'cta', { heading: 'Continue reading', body: 'A direct, valid action.', cta: { label: 'Guide', href: '/general/guide' } }, { ...appearance, background: 'brand', logoTone: 'inverse' }),
      block('40000000-0000-4000-8000-000000000014', 'richText', { anchorId: 'motion-offscreen', body: 'Rich text is escaped and rendered as readable paragraphs in this neutral starter.' }, { ...appearance, motionIntent: 'signature' }),
      block('40000000-0000-4000-8000-000000000015', 'contact', { heading: 'Contact details', body: 'This static example deliberately does not submit information.' }, { ...appearance, motionIntent: 'ambient' }),
      block('40000000-0000-4000-8000-000000000016', 'media', { mediaId: ids.image, caption: 'A synthetic placeholder image.' }),
      block('40000000-0000-4000-8000-000000000017', 'imageText', { heading: 'Image and text', body: 'An image sits beside this neutral explanatory copy.', mediaId: ids.image }),
      block('40000000-0000-4000-8000-000000000018', 'gallery', { mediaIds: [ids.image, ids.poster] }),
      block('40000000-0000-4000-8000-000000000019', 'logoStrip', { mediaIds: [ids.logo] }),
      block('40000000-0000-4000-8000-000000000020', 'video', { mediaId: ids.video, posterMediaId: ids.poster, captionsMediaId: ids.captions, transcript: 'Synthetic video transcript.' }),
      { ...block('40000000-0000-4000-8000-000000000021', 'callout', { heading: 'Hidden fixture', body: 'This must not appear.' }), hidden: true },
    ] },
    { id: ids.pillar, sectionId: ids.serviceSection, title: 'Operations', summary: 'A generic service pillar.', slug: 'operations', template: 'pillar', status: 'published', blocks: [block('40000000-0000-4000-8000-000000000022', 'featureGrid', { heading: 'Child services', items: [{ title: 'Detail', body: 'A child service is generated below.' }] })] },
    { id: ids.service, sectionId: ids.serviceSection, parentId: ids.pillar, title: 'Service detail', summary: 'A generic child service.', slug: 'detail', template: 'service', status: 'published', blocks: [block('40000000-0000-4000-8000-000000000023', 'hero', { heading: 'Service detail', body: 'A nested page built from the content tree.' })] },
    { id: ids.article, sectionId: ids.rootSection, title: 'Article', summary: 'A generic article template fixture.', slug: 'article', template: 'article', status: 'published', blocks: [block('40000000-0000-4000-8000-000000000024', 'richText', { body: 'An article uses generated context and permitted editorial blocks.' })] },
    { id: ids.listing, sectionId: ids.insightSection, title: 'Insights', summary: 'A generic listing template fixture.', slug: 'all', template: 'listing', status: 'published', blocks: [block('40000000-0000-4000-8000-000000000025', 'hero', { heading: 'Insights', body: 'A generic listing page.' })] },
    { id: ids.job, sectionId: ids.careerSection, title: 'Example role', summary: 'A generic job template fixture.', slug: 'example-role', template: 'job', status: 'published', blocks: [block('40000000-0000-4000-8000-000000000026', 'richText', { body: 'A static role description. No application form is active in this demonstration.' })] },
  ],
  media: [
    { id: ids.image, filename: 'sample-image.svg', alt: 'Abstract blue sample illustration', decorative: false, width: 800, height: 500, mimeType: 'image/svg+xml' },
    { id: ids.logo, filename: 'sample-logo.svg', alt: 'Sample Studio mark', decorative: false, width: 240, height: 120, mimeType: 'image/svg+xml' },
    { id: ids.video, filename: 'sample-video.webm', alt: 'Synthetic video placeholder', decorative: false, mimeType: 'video/webm' },
    { id: ids.poster, filename: 'sample-poster.svg', alt: 'Synthetic video poster', decorative: false, width: 1280, height: 720, mimeType: 'image/svg+xml' },
    { id: ids.captions, filename: 'sample-captions.vtt', alt: 'Video captions', decorative: true, mimeType: 'text/vtt' },
  ], redirects: [{ from: '/old-guide', to: '/general/guide', status: 301 }], changeSets: [],
});
export const demoHomepageId = ids.home;
