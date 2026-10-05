import { describe, expect, it } from 'vitest'
import { directEditChecks, directEditDefinition, uniqueDirectEditMatch, validDirectEditValue } from '../src/direct-edit-fields'

describe('ENG-026 rendered-field mapping', () => {
  it('maps only explicit Hero heading and body nodes', () => {
    expect(directEditDefinition('hero', 'heading')).toEqual({ maxLength: 120, selectors: ['h1'] })
    expect(directEditDefinition('hero', 'body')).toEqual({ maxLength: 1_000, selectors: ['h1 ~ p'] })
    expect(directEditDefinition('hero', 'cta')).toBeUndefined()
    expect(directEditDefinition('navigation', 'heading')).toBeUndefined()
    expect(directEditDefinition('serviceHero', 'body')).toBeUndefined()
    expect(uniqueDirectEditMatch(['generated', 'contract'], (value) => value === 'contract')).toBe('contract')
    expect(uniqueDirectEditMatch(['same', 'same'], (value) => value === 'same')).toBeUndefined()
  })

  it('reports required, length, and plain-text checks before save', () => {
    expect(validDirectEditValue('hero', 'heading', 'A valid rendered heading')).toBe(true)
    expect(validDirectEditValue('hero', 'heading', 'x'.repeat(121))).toBe(false)
    expect(validDirectEditValue('hero', 'body', 'A body with\nplain text.')).toBe(true)
    expect(validDirectEditValue('hero', 'body', ' control ')).toBe(false)
    expect(directEditChecks('hero', 'heading', 'bad\nheading').find((check) => check.id === 'plain-text')?.passed).toBe(false)
  })
})
