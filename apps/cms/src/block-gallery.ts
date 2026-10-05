import { createHash, randomUUID } from 'node:crypto'
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
  hero: 'Eyebrow 80 characters; heading 120 characters; body 1,000 characters; optional primary and secondary CTAs; optional supporting panel with the same text limits, internal CTA, and E.164 telephone CTA.', incidentBar: 'Message 240 characters; optional CTA.',
  pillarGrid: '1–12 linked items; item titles 100 characters and bodies 300 characters.', featureGrid: '1–12 items; item titles 100 characters and bodies 300 characters.',
  splitList: '1–10 items; item titles 100 characters and bodies 500 characters.', chipList: '1–24 chips of up to 48 characters.',
  testimonials: '1–8 permission-confirmed testimonials; quotes up to 500 characters.', faq: '1–16 questions; answers up to 2,000 characters.',
  callout: 'Heading 120 characters; body 1,000 characters; optional CTA.', relatedServices: '1–3 existing page references.',
  cta: 'Heading 120 characters; body 500 characters; CTA required.', richText: 'Rich text up to 10,000 characters.',
  contact: 'Heading 120 characters; body 500 characters; optional inquiry form.', media: 'One existing media reference; caption up to 300 characters.',
  imageText: 'Heading 120 characters; body 1,000 characters; one existing media reference.', gallery: '1–12 existing media references.',
  logoStrip: '1–12 existing media references.', video: 'Video, poster, and captions media references; optional transcript.',
}

const names: Record<Block['type'], string> = {
  hero: 'Hero', incidentBar: 'Incident bar', pillarGrid: 'Pillar grid', featureGrid: 'Feature grid', splitList: 'Split list', chipList: 'Chip list', testimonials: 'Testimonials', faq: 'FAQ', callout: 'Callout', relatedServices: 'Related services', cta: 'CTA band', richText: 'Rich text', contact: 'Contact', media: 'Media', imageText: 'Image and text', gallery: 'Gallery', logoStrip: 'Logo strip', video: 'Video',
}

const descriptions: Record<Block['type'], string> = {
  hero: 'Page introduction with optional actions and support panel.', incidentBar: 'Time-sensitive status message with an optional action.', pillarGrid: 'Linked service or capability pillars.', featureGrid: 'Scannable feature cards.', splitList: 'Paired title and body rows.', chipList: 'Compact set of topics or tags.', testimonials: 'Permission-confirmed customer quotations.', faq: 'Expandable questions and answers.', callout: 'Highlighted supporting message and action.', relatedServices: 'Links to existing related pages.', cta: 'Closing action band.', richText: 'Long-form body copy.', contact: 'Contact details and optional inquiry form.', media: 'Single image or file with caption.', imageText: 'Image paired with a heading and body.', gallery: 'Ordered set of images.', logoStrip: 'Partner or certification logos.', video: 'Video with poster, captions, and transcript.',
}

export const insertableBlockTypes = ['hero', 'incidentBar', 'featureGrid', 'splitList', 'chipList', 'faq', 'callout', 'richText', 'contact'] as const satisfies readonly Block['type'][]

export const blockCatalog = blockTypes.map((type) => ({
  type,
  name: names[type],
  description: descriptions[type],
  insertable: insertableBlockTypes.includes(type as typeof insertableBlockTypes[number]),
  allowedTemplates: TemplateSchema.options.filter((template) => TemplateAllowedBlocks[template].includes(type)),
  fieldLimits: fieldLimits[type],
}))

const appearance = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } as const

export type RecipeSelection = { type: Block['type']; appearance?: Partial<Block['appearance']> }

function selection(value: unknown): RecipeSelection {
  if (typeof value === 'string') return { type: value as Block['type'] }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Each recipe item must name one supported block.')
  const input = value as Record<string, unknown>
  return { type: input.type as Block['type'], appearance: input.appearance as RecipeSelection['appearance'] }
}

export function deterministicRecipeBlockID(requestKey: string, index: number, type: string): string {
  const bytes = createHash('sha256').update(`${requestKey}:${index}:${type}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function recipeBlocks(template: string, selected: unknown, existing: unknown = [], createID: (index: number, type: Block['type']) => string = () => randomUUID()): Block[] {
  const parsedTemplate = TemplateSchema.parse(template)
  if (!Array.isArray(selected) || selected.length === 0 || selected.length > 40) throw new Error('Choose between one and forty insertable supported blocks.')
  const selections = selected.map(selection)
  if (!selections.every(({ type }) => insertableBlockTypes.includes(type as typeof insertableBlockTypes[number]))) throw new Error('Choose between one and forty insertable supported blocks.')
  const disallowed = selections.find(({ type }) => !TemplateAllowedBlocks[parsedTemplate].includes(type))
  if (disallowed) throw new Error(`${disallowed.type} is not allowed by the ${parsedTemplate} template.`)
  if (!Array.isArray(existing)) throw new Error('Existing page blocks are invalid.')
  const current = existing.map((block) => BlockSchema.parse(block))
  const recipe = selections.map(({ type, appearance: requested }, index) => {
    const selectedAppearance = { ...appearance, ...(requested ?? {}) }
    const id = createID(index, type); const base = { id, type, hidden: false, appearance: selectedAppearance }
    const safe: Partial<Record<Block['type'], Record<string, unknown>>> = {
      hero: { ...base, heading: 'Draft heading', body: 'Replace this neutral draft text before review.' }, incidentBar: { ...base, message: 'Replace this draft status message before review.' },
      featureGrid: { ...base, heading: 'Draft features', items: [{ title: 'Draft item', body: 'Replace this neutral draft text before review.' }] },
      splitList: { ...base, heading: 'Draft list', items: [{ title: 'Draft item', body: 'Replace this neutral draft text before review.' }] },
      chipList: { ...base, heading: 'Draft topics', chips: ['Draft topic'] }, faq: { ...base, heading: 'Draft questions', items: [{ question: 'Draft question?', answer: 'Replace this neutral draft answer before review.' }] },
      callout: { ...base, heading: 'Draft callout', body: 'Replace this neutral draft text before review.' }, richText: { ...base, body: 'Replace this neutral draft text before review.' }, contact: { ...base, heading: 'Draft contact', body: 'Replace this neutral draft text before review.', inquiryForm: false },
    }
    return BlockSchema.parse(safe[type])
  })
  if (parsedTemplate === 'landing' && [...current, ...recipe].find((block) => !block.hidden)?.type !== 'hero') throw new Error('Landing pages must begin with a visible Hero.')
  return recipe
}
