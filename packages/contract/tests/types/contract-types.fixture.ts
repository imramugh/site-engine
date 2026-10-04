import type { Block, Page } from '../../src/index.js'

const appearance = {
  background: 'default',
  width: 'content',
  spacing: 'default',
  motionIntent: 'none',
  logoTone: 'default',
} as const

const validBlock: Block = {
  id: '33333333-3333-4333-8333-333333333333',
  type: 'cta',
  hidden: false,
  heading: 'A valid heading',
  body: 'A valid body.',
  cta: { label: 'Read more', href: '/details' },
  appearance,
}

const validPage: Page = {
  id: '11111111-1111-4111-8111-111111111111',
  sectionId: '22222222-2222-4222-8222-222222222222',
  title: 'A valid page',
  summary: 'A valid summary',
  slug: 'valid-page',
  template: 'listing',
  status: 'draft',
  blocks: [validBlock],
}

// @ts-expect-error Appearance is an enum-backed contract, not arbitrary CSS.
const invalidAppearance: Block = { ...validBlock, appearance: { ...appearance, background: '#ffffff' } }
// @ts-expect-error Persisted page objects reject undeclared properties.
const invalidPageField: Page = { ...validPage, unknownEditorialField: 'nope' }

void invalidAppearance
void invalidPageField
