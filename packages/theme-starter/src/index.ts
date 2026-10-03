import { BackgroundSchema, MotionIntentSchema, TemplateSchema, type Block, type Page, type SiteSnapshot } from '@site-engine/contract';

export type ThemeTokens = { color: Record<'text' | 'surface' | 'brand' | 'focus', string>; space: Record<'compact' | 'default' | 'spacious', string>; radius: string; fontFamily: string };
export type ThemeNavigationItem = { label: string; href: string };
/** Stable, framework-neutral information supplied to theme chrome and block adapters. */
export type ThemeRenderContext = { snapshot: SiteSnapshot; page: Page; pathname: string; navigation: readonly ThemeNavigationItem[] };
export type ThemeComponents = { headerClass(context: ThemeRenderContext): string; footerClass(context: ThemeRenderContext): string; blockClass(block: Block, context: ThemeRenderContext): string };
export type ThemeDescriptor = { name: string; contract: '1.0.0'; supportedTemplates: readonly string[]; supportedBlocks: readonly Block['type'][]; backgrounds: readonly string[]; motionIntents: readonly string[]; tokens: ThemeTokens; classes: { page: string; block: string; header: string; footer: string }; components: ThemeComponents };
export const starterTheme: ThemeDescriptor = {
  name: 'starter', contract: '1.0.0', supportedTemplates: TemplateSchema.options,
  supportedBlocks: ['hero', 'incidentBar', 'pillarGrid', 'featureGrid', 'splitList', 'chipList', 'testimonials', 'faq', 'callout', 'relatedServices', 'cta', 'richText', 'contact', 'media', 'imageText', 'gallery', 'logoStrip', 'video'],
  backgrounds: BackgroundSchema.options, motionIntents: MotionIntentSchema.options,
  tokens: { color: { text: '#14212b', surface: '#ffffff', brand: '#064f85', focus: '#e47d22' }, space: { compact: '1rem', default: '2rem', spacious: '5rem' }, radius: '0.25rem', fontFamily: 'system-ui, sans-serif' },
  classes: { page: 'starter-page', block: 'starter-block', header: 'starter-header', footer: 'starter-footer' },
  components: { headerClass: () => 'starter-header', footerClass: () => 'starter-footer', blockClass: (block) => `starter-block starter-block--${block.type}` },
};
export function blockLabel(block: Block): string { return block.type; }
export function themeCanRender(snapshot: SiteSnapshot): boolean { return snapshot.settings.contractVersion === starterTheme.contract; }
export function validateStarterTheme(descriptor: ThemeDescriptor): string[] { const errors: string[] = []; for (const template of TemplateSchema.options) if (!descriptor.supportedTemplates.includes(template)) errors.push(`Missing template ${template}`); for (const block of starterTheme.supportedBlocks) if (!descriptor.supportedBlocks.includes(block)) errors.push(`Missing block ${block}`); for (const background of BackgroundSchema.options) if (!descriptor.backgrounds.includes(background)) errors.push(`Missing background ${background}`); return errors; }
