import type { ThemeDescriptor } from '../../src/index.js'

// A consumer compiled against the pre-capability descriptor still typechecks.
const legacyTheme: ThemeDescriptor = {
  name: 'private-theme', contract: '1.8.0', supportedTemplates: ['standard'], supportedBlocks: ['hero'], backgrounds: ['default'], motionIntents: ['none'],
  motion: { supportedPresets: [], intentFallbacks: {} },
  tokens: { color: { text: '#000', surface: '#fff', brand: '#111', focus: '#222' }, space: { compact: '1rem', default: '2rem', spacious: '3rem' }, radius: '0', fontFamily: 'sans-serif' },
  classes: { page: 'page', block: 'block', header: 'header', footer: 'footer' }, components: { headerClass: () => 'header', footerClass: () => 'footer', blockClass: () => 'block' },
}

// @ts-expect-error Capability values are inferred from the contract enums.
const invalidCapabilities: ThemeDescriptor = { ...legacyTheme, appearance: { widths: ['free-form'], spacings: ['default'], logoTones: ['default'] } }

void invalidCapabilities
