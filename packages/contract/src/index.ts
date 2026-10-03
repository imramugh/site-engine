import { z } from 'zod';

export const CONTRACT_VERSION = '1.0.0' as const;
export const compatibleContractVersion = (candidate: string) => z.string().regex(/^1\.\d+\.\d+$/).safeParse(candidate).success;
export const ContractVersionSchema = z.literal(CONTRACT_VERSION);
const id = z.string().uuid();
const safeText = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u001f]/.test(value), 'Control characters are not allowed');

export const BackgroundSchema = z.enum(['default', 'subtle', 'brand', 'accent', 'highlight', 'inverse']);
export const WidthSchema = z.enum(['content', 'wide', 'full']);
export const SpacingSchema = z.enum(['compact', 'default', 'spacious']);
export const MotionIntentSchema = z.enum(['none', 'subtle', 'ambient', 'signature']);
export const LogoToneSchema = z.enum(['default', 'inverse']);
export const AppearanceSchema = z.object({
  background: BackgroundSchema.default('default'), width: WidthSchema.default('content'),
  spacing: SpacingSchema.default('default'), motionIntent: MotionIntentSchema.default('none'),
  backgroundImage: z.object({ mediaId: id, overlay: z.number().min(0).max(1) }).strict().optional(),
  backgroundVideo: z.object({ mediaId: id, posterMediaId: id, durationSeconds: z.number().positive().max(15), bytes: z.number().int().positive().max(3_000_000) }).strict().optional(),
  motionPreset: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).optional(), logoTone: LogoToneSchema.default('default'),
}).strict();

const InternalPathSchema = z.string().max(240).regex(/^\/(?!\/)(?!.*[\\\u0000-\u001f])[a-z0-9/_-]*$/i, 'Expected a safe root-relative path');
const LinkSchema = z.object({ label: safeText(80), href: InternalPathSchema }).strict();
// Plain text is escaped by renderers. Structured rich text is a separate editor format.
const RichTextSchema = z.string().trim().min(1).max(10_000).refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v), 'Control characters are not allowed');
const BaseBlockSchema = z.object({ id, hidden: z.boolean().default(false), anchorId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(), appearance: AppearanceSchema });
export const BlockSchemas = {
  hero: BaseBlockSchema.extend({ type: z.literal('hero'), eyebrow: safeText(80).optional(), heading: safeText(120), body: RichTextSchema.max(1_000), cta: LinkSchema.optional() }).strict(),
  incidentBar: BaseBlockSchema.extend({ type: z.literal('incidentBar'), message: safeText(240), cta: LinkSchema.optional() }).strict(),
  pillarGrid: BaseBlockSchema.extend({ type: z.literal('pillarGrid'), heading: safeText(120), items: z.array(z.object({ title: safeText(100), body: safeText(300), href: InternalPathSchema }).strict()).min(1).max(12) }).strict(),
  featureGrid: BaseBlockSchema.extend({ type: z.literal('featureGrid'), heading: safeText(120), items: z.array(z.object({ title: safeText(100), body: safeText(300) }).strict()).min(1).max(12) }).strict(),
  splitList: BaseBlockSchema.extend({ type: z.literal('splitList'), heading: safeText(120), items: z.array(z.object({ title: safeText(100), body: safeText(500) }).strict()).min(1).max(10) }).strict(),
  chipList: BaseBlockSchema.extend({ type: z.literal('chipList'), heading: safeText(120).optional(), chips: z.array(safeText(48)).min(1).max(24) }).strict(),
  testimonials: BaseBlockSchema.extend({ type: z.literal('testimonials'), items: z.array(z.object({ quote: safeText(500), attribution: safeText(100), role: safeText(100).optional(), permissionConfirmed: z.boolean() }).strict()).min(1).max(8) }).strict(),
  faq: BaseBlockSchema.extend({ type: z.literal('faq'), heading: safeText(120), items: z.array(z.object({ question: safeText(180), answer: RichTextSchema.max(2_000) }).strict()).min(1).max(16) }).strict(),
  callout: BaseBlockSchema.extend({ type: z.literal('callout'), heading: safeText(120), body: RichTextSchema.max(1_000), cta: LinkSchema.optional() }).strict(),
  relatedServices: BaseBlockSchema.extend({ type: z.literal('relatedServices'), heading: safeText(120), pageIds: z.array(id).min(1).max(3) }).strict(),
  cta: BaseBlockSchema.extend({ type: z.literal('cta'), heading: safeText(120), body: RichTextSchema.max(500), cta: LinkSchema }).strict(),
  richText: BaseBlockSchema.extend({ type: z.literal('richText'), body: RichTextSchema }).strict(),
  contact: BaseBlockSchema.extend({ type: z.literal('contact'), heading: safeText(120), body: RichTextSchema.max(500), inquiryForm: z.boolean().optional() }).strict(),
  media: BaseBlockSchema.extend({ type: z.literal('media'), mediaId: id, caption: safeText(300).optional() }).strict(),
  imageText: BaseBlockSchema.extend({ type: z.literal('imageText'), heading: safeText(120), body: RichTextSchema.max(1_000), mediaId: id }).strict(),
  gallery: BaseBlockSchema.extend({ type: z.literal('gallery'), mediaIds: z.array(id).min(1).max(12) }).strict(),
  logoStrip: BaseBlockSchema.extend({ type: z.literal('logoStrip'), mediaIds: z.array(id).min(1).max(12) }).strict(),
  video: BaseBlockSchema.extend({ type: z.literal('video'), mediaId: id, posterMediaId: id, captionsMediaId: id, transcript: RichTextSchema.optional() }).strict(),
} as const;
export const BlockSchema = z.discriminatedUnion('type', [BlockSchemas.hero, BlockSchemas.incidentBar, BlockSchemas.pillarGrid, BlockSchemas.featureGrid, BlockSchemas.splitList, BlockSchemas.chipList, BlockSchemas.testimonials, BlockSchemas.faq, BlockSchemas.callout, BlockSchemas.relatedServices, BlockSchemas.cta, BlockSchemas.richText, BlockSchemas.contact, BlockSchemas.media, BlockSchemas.imageText, BlockSchemas.gallery, BlockSchemas.logoStrip, BlockSchemas.video]).superRefine((block, ctx) => {
  if (['incidentBar', 'contact'].includes(block.type) && block.appearance.backgroundVideo) {
    ctx.addIssue({ code: 'custom', path: ['appearance', 'backgroundVideo'], message: 'Incident and contact blocks cannot use background video' });
  }
});
export type Block = z.infer<typeof BlockSchema>;

export const TemplateSchema = z.enum(['landing', 'standard', 'listing', 'pillar', 'service', 'article', 'job']);
const generalBlocks = Object.keys(BlockSchemas).filter((type) => type !== 'contact') as Block['type'][];
export const TemplateAllowedBlocks: Record<z.infer<typeof TemplateSchema>, readonly Block['type'][]> = {
  landing: generalBlocks,
  standard: Object.keys(BlockSchemas) as Block['type'][],
  service: generalBlocks.filter((type) => type !== 'pillarGrid'),
  pillar: ['featureGrid', 'callout', 'faq', 'richText', 'media', 'imageText', 'gallery', 'logoStrip', 'video', 'cta'],
  article: ['richText', 'media', 'imageText', 'video', 'callout', 'faq'],
  listing: ['hero', 'richText', 'callout', 'cta'],
  job: ['richText', 'callout', 'media'],
};
export const SectionPresets = {
  root: ['landing', 'standard'],
  services: ['landing', 'pillar', 'service'],
  insights: ['listing', 'article'],
  careers: ['listing', 'job'],
  landing: ['landing', 'standard', 'article'],
} as const satisfies Record<string, readonly z.infer<typeof TemplateSchema>[]>;
const JobPostingSchema = z.object({
  datePosted: z.string().datetime(), employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY', 'INTERN', 'OTHER']),
  location: z.object({ addressLocality: safeText(100), addressRegion: safeText(100).optional(), addressCountry: z.string().regex(/^[A-Z]{2}$/) }).strict(),
  validThrough: z.string().datetime().optional(),
}).strict().superRefine((job, ctx) => { if (job.validThrough && new Date(job.validThrough) <= new Date(job.datePosted)) ctx.addIssue({ code: 'custom', path: ['validThrough'], message: 'Job closing time must be after its posting time.' }); });
export const PageSchema = z.object({ id, sectionId: id, parentId: id.optional(), title: safeText(160), summary: safeText(300), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), template: TemplateSchema, status: z.enum(['draft', 'published', 'archived']), blocks: z.array(BlockSchema).max(40), seoDescription: safeText(160).optional(), publishedAt: z.string().datetime().optional(), updatedAt: z.string().datetime().optional(), jobPosting: JobPostingSchema.optional() }).strict().superRefine((page, ctx) => {
  if (page.template === 'landing' && page.blocks.find((block) => !block.hidden)?.type !== 'hero') ctx.addIssue({ code: 'custom', path: ['blocks'], message: 'Landing pages must begin with a visible Hero' });
  if (page.template !== 'job' && page.jobPosting) ctx.addIssue({ code: 'custom', path: ['jobPosting'], message: 'Job metadata is only allowed on job pages.' });
  const allowed = TemplateAllowedBlocks[page.template]; page.blocks.forEach((block, index) => { if (!allowed.includes(block.type)) ctx.addIssue({ code: 'custom', path: ['blocks', index, 'type'], message: `${block.type} is not allowed by ${page.template}` }); });
});
export const SectionSchema = z.object({ id, landingPageId: id.optional(), name: safeText(80), summary: safeText(300).optional(), slug: z.string().regex(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/), allowedTemplates: z.array(TemplateSchema).min(1), pageIds: z.array(id).max(100) }).strict();
const MediaFilenameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/);
const MediaDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const MediaMimeTypeSchema = z.enum(['image/avif', 'image/jpeg', 'image/png', 'image/webp', 'image/svg+xml', 'video/mp4', 'video/webm', 'text/vtt']);
const MediaVariantSchema = z.object({ filename: MediaFilenameSchema, width: z.number().int().positive(), height: z.number().int().positive(), mimeType: z.enum(['image/avif', 'image/jpeg', 'image/png', 'image/webp']), sha256: MediaDigestSchema }).strict();
const MediaVariantsSchema = z.object({ heroAvif: MediaVariantSchema.optional(), heroWebp: MediaVariantSchema.optional(), cardAvif: MediaVariantSchema.optional(), cardWebp: MediaVariantSchema.optional(), thumbnailAvif: MediaVariantSchema.optional(), thumbnailWebp: MediaVariantSchema.optional() }).strict();
export const MediaReferenceSchema = z.object({ id, filename: MediaFilenameSchema, sha256: MediaDigestSchema.optional(), variants: MediaVariantsSchema.optional(), alt: safeText(240).optional(), decorative: z.boolean().default(false), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), mimeType: MediaMimeTypeSchema }).strict().superRefine((media, ctx) => { if (media.mimeType.startsWith('image/') && (!media.width || !media.height)) ctx.addIssue({ code: 'custom', path: ['width'], message: 'Images require intrinsic width and height' }); if (!media.decorative && !media.alt) ctx.addIssue({ code: 'custom', path: ['alt'], message: 'Non-decorative media requires alt text' }); });
export const RedirectSchema = z.object({ from: InternalPathSchema, to: InternalPathSchema, status: z.literal(301) }).strict();
const ThemeNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const ThemeSettingValueSchema = z.union([z.string().max(2_000), z.number().finite(), z.boolean()]);
export const ThemeSelectionSchema = z.object({ id: ThemeNameSchema, version: z.string().regex(/^\d+\.\d+\.\d+$/), contract: z.string().regex(/^1\.\d+\.\d+$/), manifestDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const SiteSettingsSchema = z.object({ contractVersion: ContractVersionSchema, siteName: safeText(100), homepageId: id.optional(), defaultLocale: z.enum(['en', 'en-CA']), organizationType: z.enum(['organization', 'professional-service']).optional(), logo: MediaReferenceSchema.optional(), sections: z.array(SectionSchema).max(20), theme: ThemeSelectionSchema.optional(), themeSettings: z.record(ThemeNameSchema, z.record(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), ThemeSettingValueSchema)).default({}) }).strict();
export const ChangeSetStateSchema = z.enum(['open', 'submitted', 'changes-requested', 'approved', 'rejected', 'published', 'discarded', 'stale']);
export const ChangeSetSchema = z.object({
  id,
  name: safeText(120),
  state: ChangeSetStateSchema,
  revision: z.number().int().nonnegative(),
}).strict();
const MotionPresetSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const ThemeMotionSchema = z.object({
  presets: z.array(MotionPresetSchema).max(16).refine((presets) => new Set(presets).size === presets.length, 'Motion presets must be unique'),
  intentFallbacks: z.partialRecord(MotionIntentSchema, MotionPresetSchema),
}).strict().superRefine((motion, ctx) => {
  for (const [intent, preset] of Object.entries(motion.intentFallbacks)) {
    if (intent === 'none') ctx.addIssue({ code: 'custom', path: ['intentFallbacks', intent], message: 'The none intent cannot have a motion fallback' });
    if (!motion.presets.includes(preset)) ctx.addIssue({ code: 'custom', path: ['intentFallbacks', intent], message: 'Motion fallback must reference a declared preset' });
  }
});
export const ThemeManifestSchema = z.object({ name: ThemeNameSchema, version: z.string().regex(/^\d+\.\d+\.\d+$/), contract: z.string().regex(/^1\.\d+\.\d+$/), entry: z.string().regex(/^\.\/dist\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.js$/), motion: ThemeMotionSchema.optional(), standardBlocks: z.array(z.enum(Object.keys(BlockSchemas) as [keyof typeof BlockSchemas, ...(keyof typeof BlockSchemas)[]])).default(Object.keys(BlockSchemas) as Block['type'][]), settingKeys: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(32).default([]), extensionBlocks: z.array(z.string().regex(/^x-[a-z][a-z0-9-]{0,63}$/)).max(16).default([]) }).strict();
export const ThemeInstallSchema = z.object({ manifest: ThemeManifestSchema, installedAt: z.string().datetime() }).strict().superRefine(({ manifest }, ctx) => { if (!compatibleContractVersion(manifest.contract)) ctx.addIssue({ code: 'custom', path: ['manifest', 'contract'], message: `Theme requires incompatible contract ${manifest.contract}` }); });
export const SiteSnapshotSchema = z.object({
  settings: SiteSettingsSchema,
  pages: z.array(PageSchema),
  media: z.array(MediaReferenceSchema),
  redirects: z.array(RedirectSchema),
  changeSets: z.array(ChangeSetSchema),
}).strict().superRefine((snapshot, ctx) => {
  const sections = new Map(snapshot.settings.sections.map((section) => [section.id, section]));
  const pages = new Map(snapshot.pages.map((page) => [page.id, page]));
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (sections.size !== snapshot.settings.sections.length) issue(['settings', 'sections'], 'Section IDs must be unique');
  if (pages.size !== snapshot.pages.length) issue(['pages'], 'Page IDs must be unique');
  if (snapshot.settings.homepageId && pages.get(snapshot.settings.homepageId)?.template !== 'landing') issue(['settings', 'homepageId'], 'Homepage must reference a landing page');
  const assets = new Map(snapshot.media.map((asset) => [asset.id, asset]));
  if (assets.size !== snapshot.media.length) issue(['media'], 'Media IDs must be unique');
  const siblingSlugs = new Set<string>();
  for (const [index, page] of snapshot.pages.entries()) {
    const section = sections.get(page.sectionId);
    if (!section) issue(['pages', index, 'sectionId'], 'Page references an unknown section');
    else if (!section.allowedTemplates.includes(page.template)) issue(['pages', index, 'template'], 'Template is not allowed in this section');
    const key = `${page.sectionId}/${page.parentId ?? ''}/${page.slug}`;
    if (siblingSlugs.has(key)) issue(['pages', index, 'slug'], 'Sibling page slugs must be unique');
    siblingSlugs.add(key);
    if (page.template === 'service' && (!page.parentId || pages.get(page.parentId)?.template !== 'pillar')) {
      issue(['pages', index, 'parentId'], 'Service pages require a pillar parent');
    }
    const visited = new Set([page.id]);
    let current = page;
    let depth = 1;
    while (current.parentId) {
      if (visited.has(current.parentId)) { issue(['pages', index, 'parentId'], 'Page ancestry contains a cycle'); break; }
      visited.add(current.parentId);
      const parent = pages.get(current.parentId);
      if (!parent) { issue(['pages', index, 'parentId'], 'Page references an unknown parent'); break; }
      if (parent.sectionId !== page.sectionId) { issue(['pages', index, 'parentId'], 'Parent must belong to the same section'); break; }
      if (++depth > 3) { issue(['pages', index, 'parentId'], 'Page tree depth cannot exceed three'); break; }
      current = parent;
    }
    page.blocks.forEach((block, blockIndex) => {
      const mediaReference = (assetId: string, field: string, mimePrefix: string) => {
        const asset = assets.get(assetId);
        if (!asset || !asset.mimeType.startsWith(mimePrefix)) issue(['pages', index, 'blocks', blockIndex, field], `Expected an existing ${mimePrefix} asset`);
      };
      if (block.type === 'media' || block.type === 'imageText') mediaReference(block.mediaId, 'mediaId', 'image/');
      if (block.type === 'gallery' || block.type === 'logoStrip') block.mediaIds.forEach((assetId) => mediaReference(assetId, 'mediaIds', 'image/'));
      if (block.type === 'video') {
        mediaReference(block.mediaId, 'mediaId', 'video/');
        mediaReference(block.posterMediaId, 'posterMediaId', 'image/');
        mediaReference(block.captionsMediaId, 'captionsMediaId', 'text/vtt');
      }
      if (block.appearance.backgroundImage) mediaReference(block.appearance.backgroundImage.mediaId, 'appearance.backgroundImage', 'image/');
      if (block.appearance.backgroundVideo) {
        mediaReference(block.appearance.backgroundVideo.mediaId, 'appearance.backgroundVideo.mediaId', 'video/');
        mediaReference(block.appearance.backgroundVideo.posterMediaId, 'appearance.backgroundVideo.posterMediaId', 'image/');
      }
      if (block.type === 'relatedServices') block.pageIds.forEach((pageId) => {
        if (pages.get(pageId)?.template !== 'service') issue(['pages', index, 'blocks', blockIndex, 'pageIds'], 'Related services must reference service pages');
      });
    });
    const anchors = page.blocks.map((block) => block.anchorId).filter(Boolean);
    if (new Set(anchors).size !== anchors.length) issue(['pages', index, 'blocks'], 'Block anchors must be unique within a page');
    if (new Set(page.blocks.map((block) => block.id)).size !== page.blocks.length) issue(['pages', index, 'blocks'], 'Block IDs must be unique within a page');
  }
  snapshot.settings.sections.forEach((section, index) => {
    if (section.landingPageId && pages.get(section.landingPageId)?.sectionId !== section.id) issue(['settings', 'sections', index, 'landingPageId'], 'Section landing page must belong to its section');
    section.pageIds.forEach((pageId, referenceIndex) => {
      if (pages.get(pageId)?.sectionId !== section.id) issue(['settings', 'sections', index, 'pageIds', referenceIndex], 'Section references a missing page or a page in another section');
    });
  });
});
export type Page = z.infer<typeof PageSchema>;
export type Section = z.infer<typeof SectionSchema>;
export type SiteSnapshot = z.infer<typeof SiteSnapshotSchema>;
export type { PublicRoute, RouteModel } from './render-types.js';
