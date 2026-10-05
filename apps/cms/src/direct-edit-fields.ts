export type DirectEditField = 'eyebrow' | 'heading' | 'body' | 'caption' | 'transcript'

export const directEditFields = ['eyebrow', 'heading', 'body', 'caption', 'transcript'] as const satisfies readonly DirectEditField[]

export type DirectEditCheck = {
  id: 'required' | 'length' | 'plain-text'
  label: string
  passed: boolean
}

const definitions = {
  hero: {
    eyebrow: { maxLength: 80, selectors: ['.hero__eyebrow', '.wf-label', '.cs-label', '.pt-label'] },
    heading: { maxLength: 120, selectors: ['h1'] },
    body: { maxLength: 1_000, selectors: ['h1 ~ p'] },
  },
  pillarGrid: { heading: { maxLength: 120, selectors: ['h2'] } },
  featureGrid: { heading: { maxLength: 120, selectors: ['h2'] } },
  splitList: { heading: { maxLength: 120, selectors: ['h2'] } },
  faq: { heading: { maxLength: 120, selectors: ['h2'] } },
  callout: {
    heading: { maxLength: 120, selectors: ['h2'] },
    body: { maxLength: 1_000, selectors: ['p'] },
  },
  relatedServices: { heading: { maxLength: 120, selectors: ['h2'] } },
  cta: {
    heading: { maxLength: 120, selectors: ['h2'] },
    body: { maxLength: 500, selectors: ['p'] },
  },
  richText: { body: { maxLength: 10_000, selectors: ['p'] } },
  contact: {
    heading: { maxLength: 120, selectors: ['h2'] },
    body: { maxLength: 500, selectors: ['p'] },
  },
  media: { caption: { maxLength: 300, selectors: ['figcaption'] } },
  imageText: {
    heading: { maxLength: 120, selectors: ['h2'] },
    body: { maxLength: 1_000, selectors: ['p'] },
  },
  video: { transcript: { maxLength: 10_000, selectors: ['details p'] } },
} as const

export type DirectEditDefinition = {
  maxLength: number
  selectors: readonly string[]
}

type PageOwnership = {
  template?: unknown
  title?: unknown
  summary?: unknown
  kicker?: unknown
  lede?: unknown
  blocks?: unknown
}

type BlockOwnership = { id?: unknown; type?: unknown; hidden?: unknown }

export function directEditDefinition(blockType: string, field: string): DirectEditDefinition | undefined {
  const block = definitions[blockType as keyof typeof definitions] as Partial<Record<DirectEditField, DirectEditDefinition>> | undefined
  return block?.[field as DirectEditField]
}

/** The site renderer replaces the first visible Service Hero's eyebrow,
 * heading, and body with page metadata when kicker or lede is configured.
 * Those rendered values are not owned by the block even when the text happens
 * to be identical, so direct editing must fail closed before DOM matching. */
export function directEditDefinitionForPage(page: PageOwnership, block: BlockOwnership, field: string): DirectEditDefinition | undefined {
  const definition = directEditDefinition(String(block.type ?? ''), field)
  if (!definition) return undefined
  if (page.template !== 'service' || (!page.kicker && !page.lede) || block.type !== 'hero' || block.hidden === true || !Array.isArray(page.blocks)) return definition
  const firstVisibleHero = page.blocks.find((candidate) => candidate && typeof candidate === 'object' && (candidate as BlockOwnership).type === 'hero' && (candidate as BlockOwnership).hidden !== true) as BlockOwnership | undefined
  return firstVisibleHero?.id === block.id ? undefined : definition
}

export function uniqueDirectEditMatch<T>(candidates: readonly T[], matches: (candidate: T) => boolean): T | undefined {
  const exact = candidates.filter(matches)
  return exact.length === 1 ? exact[0] : undefined
}

export function directEditChecks(blockType: string, field: string, value: string): DirectEditCheck[] {
  const definition = directEditDefinition(blockType, field)
  if (!definition) return [
    { id: 'required', label: 'This rendered field is not available for direct editing.', passed: false },
  ]
  const trimmed = value.trim()
  const controls = field !== 'body' && field !== 'transcript'
    ? /[\u0000-\u001f]/
    : /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/
  return [
    { id: 'required', label: 'Text is present and has no surrounding whitespace.', passed: Boolean(trimmed) && trimmed === value },
    { id: 'length', label: `${value.length} of ${definition.maxLength} characters`, passed: value.length <= definition.maxLength },
    { id: 'plain-text', label: 'Plain text contains no unsupported control characters.', passed: !controls.test(value) },
  ]
}

export function validDirectEditValue(blockType: string, field: string, value: string): boolean {
  return directEditChecks(blockType, field, value).every((check) => check.passed)
}
