import { describe, expect, it } from 'vitest'
import { directEditChecks, directEditDefinition, directEditDefinitionForPage, uniqueDirectEditMatch, validDirectEditValue } from '../src/direct-edit-fields'

describe('ENG-026 rendered-field mapping', () => {
  it('maps only explicit top-level text shared by the public and private renderers', () => {
    expect(directEditDefinition('hero', 'eyebrow')).toEqual({ maxLength: 80, selectors: ['.hero__eyebrow', '.wf-label', '.cs-label', '.pt-label'] })
    expect(directEditDefinition('hero', 'heading')).toEqual({ maxLength: 120, selectors: ['h1'] })
    expect(directEditDefinition('hero', 'body')).toEqual({ maxLength: 1_000, selectors: ['h1 ~ p'] })
    expect(directEditDefinition('callout', 'body')).toEqual({ maxLength: 1_000, selectors: ['p'] })
    expect(directEditDefinition('media', 'caption')).toEqual({ maxLength: 300, selectors: ['figcaption'] })
    expect(directEditDefinition('video', 'transcript')).toEqual({ maxLength: 10_000, selectors: ['details p'] })
    const supported = [
      ['hero', 'eyebrow'], ['hero', 'heading'], ['hero', 'body'],
      ['pillarGrid', 'heading'], ['featureGrid', 'heading'], ['splitList', 'heading'], ['faq', 'heading'],
      ['callout', 'heading'], ['callout', 'body'], ['relatedServices', 'heading'], ['cta', 'heading'], ['cta', 'body'],
      ['richText', 'body'], ['contact', 'heading'], ['contact', 'body'], ['media', 'caption'],
      ['imageText', 'heading'], ['imageText', 'body'], ['video', 'transcript'],
    ] as const
    expect(supported.every(([block, field]) => directEditDefinition(block, field))).toBe(true)
    expect(directEditDefinition('hero', 'cta')).toBeUndefined()
    expect(directEditDefinition('pillarGrid', 'body')).toBeUndefined()
    expect(directEditDefinition('chipList', 'heading')).toBeUndefined()
    expect(directEditDefinition('faq', 'answer')).toBeUndefined()
    expect(directEditDefinition('relatedServices', 'links')).toBeUndefined()
    expect(directEditDefinition('navigation', 'heading')).toBeUndefined()
    expect(directEditDefinition('serviceHero', 'body')).toBeUndefined()
    expect(uniqueDirectEditMatch(['generated', 'contract'], (value) => value === 'contract')).toBe('contract')
    expect(uniqueDirectEditMatch(['same', 'same'], (value) => value === 'same')).toBeUndefined()
  })

  it('never maps a Service Hero replaced by page metadata, including equal text', () => {
    const hero = { id: 'hero', type: 'hero', heading: 'Same', body: 'Same body', hidden: false }
    const page = { template: 'service', title: 'Same', kicker: 'Same eyebrow', lede: 'Same body', blocks: [hero] }
    expect(directEditDefinitionForPage(page, hero, 'heading')).toBeUndefined()
    expect(directEditDefinitionForPage({ ...page, title: 'Different', lede: 'Different body' }, hero, 'body')).toBeUndefined()
    expect(directEditDefinitionForPage({ ...page, kicker: undefined, lede: undefined }, hero, 'heading')).toEqual({ maxLength: 120, selectors: ['h1'] })
    expect(directEditDefinitionForPage({ ...page, blocks: [{ ...hero, id: 'first' }, hero] }, hero, 'heading')).toEqual({ maxLength: 120, selectors: ['h1'] })
  })

  it('reports required, length, and plain-text checks before save', () => {
    expect(validDirectEditValue('hero', 'heading', 'A valid rendered heading')).toBe(true)
    expect(validDirectEditValue('hero', 'heading', 'x'.repeat(121))).toBe(false)
    expect(validDirectEditValue('hero', 'body', 'A body with\nplain text.')).toBe(true)
    expect(validDirectEditValue('video', 'transcript', 'A transcript with\nplain text.')).toBe(true)
    expect(validDirectEditValue('media', 'caption', 'bad\ncaption')).toBe(false)
    expect(validDirectEditValue('hero', 'body', ' control ')).toBe(false)
    expect(directEditChecks('hero', 'heading', 'bad\nheading').find((check) => check.id === 'plain-text')?.passed).toBe(false)
  })
})
