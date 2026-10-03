import { randomUUID } from 'node:crypto'
import { BlockSchema, BlockSchemas, TemplateAllowedBlocks, TemplateSchema, type Block } from '@site-engine/contract'

export const blockTypes = Object.keys(BlockSchemas) as Block['type'][]
export const appearanceOptions = {
  backgrounds: ['default', 'subtle', 'brand', 'accent', 'highlight', 'inverse'],
  widths: ['content', 'wide', 'full'],
  spacing: ['compact', 'default', 'spacious'],
  motionIntents: ['none', 'subtle', 'ambient', 'signature'],
  logoTones: ['default', 'inverse'],
} as const

const fieldLimits: Record<Block['type'], string> = {
  hero: 'Heading 120 characters; body 1,000 characters; optional CTA.', incidentBar: 'Message 240 characters; optional CTA.',
  pillarGrid: '1–12 linked items; item titles 100 characters and bodies 300 characters.', featureGrid: '1–12 items; item titles 100 characters and bodies 300 characters.',
  splitList: '1–10 items; item titles 100 characters and bodies 500 characters.', chipList: '1–24 chips of up to 48 characters.',
  testimonials: '1–8 permission-confirmed testimonials; quotes up to 500 characters.', faq: '1–16 questions; answers up to 2,000 characters.',
  callout: 'Heading 120 characters; body 1,000 characters; optional CTA.', relatedServices: '1–3 existing page references.',
  cta: 'Heading 120 characters; body 500 characters; CTA required.', richText: 'Rich text up to 10,000 characters.',
  contact: 'Heading 120 characters; body 500 characters; optional inquiry form.', media: 'One existing media reference; caption up to 300 characters.',
  imageText: 'Heading 120 characters; body 1,000 characters; one existing media reference.', gallery: '1–12 existing media references.',
  logoStrip: '1–12 existing media references.', video: 'Video, poster, and captions media references; optional transcript.',
}

export const blockCatalog = blockTypes.map((type) => ({
  type,
  allowedTemplates: TemplateSchema.options.filter((template) => TemplateAllowedBlocks[template].includes(type)),
  fieldLimits: fieldLimits[type],
}))

const appearance = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } as const
const mediaID = 'a0000000-0000-4000-8000-000000000001'
const posterID = 'a0000000-0000-4000-8000-000000000002'
const captionsID = 'a0000000-0000-4000-8000-000000000003'
const relatedPageID = 'a0000000-0000-4000-8000-000000000004'
const link = { label: 'Learn more', href: '/example' }

/** Server-owned neutral examples. Editors select block kinds; they never submit
 * arbitrary JSON recipes through this convenience workflow. */
export function fixtureBlock(type: Block['type']): Block {
  const id = randomUUID()
  const base = { id, type, hidden: false, appearance }
  const value: Record<Block['type'], Record<string, unknown>> = {
    hero: { ...base, eyebrow: 'Example', heading: 'Example heading', body: 'Neutral example body text.', cta: link },
    incidentBar: { ...base, message: 'Example status message.', cta: link },
    pillarGrid: { ...base, heading: 'Example pillars', items: [{ title: 'Example item', body: 'Neutral supporting text.', href: '/example' }] },
    featureGrid: { ...base, heading: 'Example features', items: [{ title: 'Example item', body: 'Neutral supporting text.' }] },
    splitList: { ...base, heading: 'Example list', items: [{ title: 'Example item', body: 'Neutral supporting text.' }] },
    chipList: { ...base, heading: 'Example topics', chips: ['Example'] },
    testimonials: { ...base, items: [{ quote: 'Example permission-confirmed quote.', attribution: 'Example person', permissionConfirmed: true }] },
    faq: { ...base, heading: 'Example questions', items: [{ question: 'What is this?', answer: 'A neutral example answer.' }] },
    callout: { ...base, heading: 'Example callout', body: 'Neutral supporting text.', cta: link },
    relatedServices: { ...base, heading: 'Related examples', pageIds: [relatedPageID] },
    cta: { ...base, heading: 'Example action', body: 'Neutral supporting text.', cta: link },
    richText: { ...base, body: 'Neutral example rich text.' },
    contact: { ...base, heading: 'Example contact', body: 'Neutral supporting text.', inquiryForm: false },
    media: { ...base, mediaId: mediaID, caption: 'Example media caption.' },
    imageText: { ...base, heading: 'Example image and text', body: 'Neutral supporting text.', mediaId: mediaID },
    gallery: { ...base, mediaIds: [mediaID] },
    logoStrip: { ...base, mediaIds: [mediaID] },
    video: { ...base, mediaId: mediaID, posterMediaId: posterID, captionsMediaId: captionsID, transcript: 'Neutral example transcript.' },
  }
  return BlockSchema.parse(value[type])
}

export function recipeBlocks(template: string, selected: unknown): Block[] {
  const parsedTemplate = TemplateSchema.parse(template)
  if (!Array.isArray(selected) || selected.length === 0 || selected.length > 40 || !selected.every((type): type is Block['type'] => typeof type === 'string' && blockTypes.includes(type as Block['type']))) throw new Error('Choose between one and forty supported blocks.')
  const disallowed = selected.find((type) => !TemplateAllowedBlocks[parsedTemplate].includes(type))
  if (disallowed) throw new Error(`${disallowed} is not allowed by the ${parsedTemplate} template.`)
  if (parsedTemplate === 'landing' && selected[0] !== 'hero') throw new Error('Landing recipes must begin with Hero.')
  return selected.map((type) => fixtureBlock(type))
}
