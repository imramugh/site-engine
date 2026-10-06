import { BackgroundSchema, CONTRACT_VERSION, LogoToneSchema, MotionIntentSchema, SpacingSchema, SUPPORTED_CONTRACT_VERSIONS, TemplateSchema, WidthSchema, type Appearance, type Block, type Page, type SiteSnapshot } from '@site-engine/contract';

export type ThemeTokens = { color: Record<'text' | 'surface' | 'brand' | 'focus', string>; space: Record<'compact' | 'default' | 'spacious', string>; radius: string; fontFamily: string };
export type ThemeNavigationItem = { label: string; href: string };
export type ThemeMotion = { supportedPresets: readonly string[]; intentFallbacks: Readonly<Record<string, string>> };
/** Stable, framework-neutral information supplied to theme chrome and block adapters. */
export type ThemeRenderContext = { snapshot: SiteSnapshot; page: Page; pathname: string; navigation: readonly ThemeNavigationItem[] };
export type ThemeComponents = { headerClass(context: ThemeRenderContext): string; footerClass(context: ThemeRenderContext): string; blockClass(block: Block, context: ThemeRenderContext): string };
/** Additive capability metadata for themes that implement the full visual
 * contract. Existing 1.x descriptors remain valid when they omit it. */
export type ThemeAppearanceCapabilities = { widths: readonly Appearance['width'][]; spacings: readonly Appearance['spacing'][]; logoTones: readonly Appearance['logoTone'][] };
export type ThemeDescriptor = { name: string; contract: typeof CONTRACT_VERSION; supportedTemplates: readonly string[]; supportedBlocks: readonly Block['type'][]; backgrounds: readonly string[]; motionIntents: readonly string[]; appearance?: ThemeAppearanceCapabilities; motion: ThemeMotion; tokens: ThemeTokens; classes: { page: string; block: string; header: string; footer: string }; components: ThemeComponents };
export const starterTheme: ThemeDescriptor = {
  name: 'starter', contract: CONTRACT_VERSION, supportedTemplates: TemplateSchema.options,
  supportedBlocks: ['hero', 'incidentBar', 'pillarGrid', 'featureGrid', 'splitList', 'chipList', 'testimonials', 'faq', 'callout', 'relatedServices', 'cta', 'richText', 'contact', 'media', 'imageText', 'gallery', 'logoStrip', 'video'],
  backgrounds: BackgroundSchema.options, motionIntents: MotionIntentSchema.options,
  appearance: { widths: WidthSchema.options, spacings: SpacingSchema.options, logoTones: LogoToneSchema.options },
  motion: {
    supportedPresets: ['subtle', 'ambient', 'signature'],
    intentFallbacks: { subtle: 'subtle', ambient: 'ambient', signature: 'signature' },
  },
  tokens: { color: { text: '#14212b', surface: '#ffffff', brand: '#064f85', focus: '#e47d22' }, space: { compact: '1rem', default: '2rem', spacious: '5rem' }, radius: '0.25rem', fontFamily: 'system-ui, sans-serif' },
  classes: { page: 'starter-page', block: 'starter-block', header: 'starter-header', footer: 'starter-footer' },
  components: { headerClass: () => 'starter-header', footerClass: () => 'starter-footer', blockClass: (block) => `starter-block starter-block--${block.type}` },
};
export function blockLabel(block: Block): string { return block.type; }
/** The current starter preserves render compatibility with every frozen public contract. */
export function themeCanRender(snapshot: SiteSnapshot): boolean { return (SUPPORTED_CONTRACT_VERSIONS as readonly string[]).includes(snapshot.settings.contractVersion); }
export function validateStarterTheme(descriptor: ThemeDescriptor): string[] { const errors: string[] = []; for (const template of TemplateSchema.options) if (!descriptor.supportedTemplates.includes(template)) errors.push(`Missing template ${template}`); for (const block of starterTheme.supportedBlocks) if (!descriptor.supportedBlocks.includes(block)) errors.push(`Missing block ${block}`); for (const background of BackgroundSchema.options) if (!descriptor.backgrounds.includes(background)) errors.push(`Missing background ${background}`); if (descriptor.appearance) { for (const width of WidthSchema.options) if (!descriptor.appearance.widths.includes(width)) errors.push(`Missing width ${width}`); for (const spacing of SpacingSchema.options) if (!descriptor.appearance.spacings.includes(spacing)) errors.push(`Missing spacing ${spacing}`); for (const tone of LogoToneSchema.options) if (!descriptor.appearance.logoTones.includes(tone)) errors.push(`Missing logo tone ${tone}`); } if (!descriptor.motion.supportedPresets.length) errors.push('Missing motion presets'); return errors; }
