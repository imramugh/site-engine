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
  hero: 'Eyebrow 80 characters; heading 120 characters; body 1,000 characters; optional primary and secondary CTAs; optional supporting panel with the same text limits.', incidentBar: 'Message 240 characters; optional CTA.',
  pillarGrid: '1–12 linked items; item titles 100 characters and bodies 300 characters.', featureGrid: '1–12 items; item titles 100 characters and bodies 300 characters.',
  splitList: '1–10 items; item titles 100 characters and bodies 500 characters.', chipList: '1–24 chips of up to 48 characters.',
  testimonials: '1–8 permission-confirmed testimonials; quotes up to 500 characters.', faq: '1–16 questions; answers up to 2,000 characters.',
  callout: 'Heading 120 characters; body 1,000 characters; optional CTA.', relatedServices: '1–3 existing page references.',
  cta: 'Heading 120 characters; body 500 characters; CTA required.', richText: 'Rich text up to 10,000 characters.',
  contact: 'Heading 120 characters; body 500 characters; optional inquiry form.', media: 'One existing media reference; caption up to 300 characters.',
  imageText: 'Heading 120 characters; body 1,000 characters; one existing media reference.', gallery: '1–12 existing media references.',
  logoStrip: '1–12 existing media references.', video: 'Video, poster, and captions media references; optional transcript.',
}

export const insertableBlockTypes = ['hero', 'incidentBar', 'featureGrid', 'splitList', 'chipList', 'faq', 'callout', 'richText', 'contact'] as const satisfies readonly Block['type'][]

export const blockCatalog = blockTypes.map((type) => ({
  type,
  insertable: insertableBlockTypes.includes(type as typeof insertableBlockTypes[number]),
  allowedTemplates: TemplateSchema.options.filter((template) => TemplateAllowedBlocks[template].includes(type)),
  fieldLimits: fieldLimits[type],
}))

const appearance = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } as const

export function recipeBlocks(template: string, selected: unknown, existing: unknown = []): Block[] {
  const parsedTemplate = TemplateSchema.parse(template)
  if (!Array.isArray(selected) || selected.length === 0 || selected.length > 40 || !selected.every((type): type is Block['type'] => typeof type === 'string' && insertableBlockTypes.includes(type as typeof insertableBlockTypes[number]))) throw new Error('Choose between one and forty insertable supported blocks.')
  const disallowed = selected.find((type) => !TemplateAllowedBlocks[parsedTemplate].includes(type))
  if (disallowed) throw new Error(`${disallowed} is not allowed by the ${parsedTemplate} template.`)
  if (!Array.isArray(existing)) throw new Error('Existing page blocks are invalid.')
  const current = existing.map((block) => BlockSchema.parse(block))
  const recipe = selected.map((type) => {
    const id = randomUUID(); const base = { id, type, hidden: false, appearance }
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
