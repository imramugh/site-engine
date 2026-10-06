import { expect, test } from 'vitest'
import { BlockSchemas, TemplateAllowedBlocks } from '@site-engine/contract'
import { blockCatalog, deterministicRecipeBlockID, recipeBlocks, recipeRequiredSelections } from '../src/block-gallery'

const appearance = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' }
const hero = { id: '10000000-0000-4000-8000-000000000001', type: 'hero', heading: 'Existing hero', body: 'Existing landing content.', hidden: false, appearance }

test('block gallery represents every contract block and recipe validation follows template policy', () => {
  expect(blockCatalog.map((item) => item.type).sort()).toEqual(Object.keys(BlockSchemas).sort())
  for (const item of blockCatalog) expect(item.allowedTemplates).toEqual(expect.arrayContaining(Object.keys(TemplateAllowedBlocks).filter((template) => TemplateAllowedBlocks[template as keyof typeof TemplateAllowedBlocks].includes(item.type))))
  expect(recipeBlocks('landing', ['hero', 'faq']).map((block) => block.type)).toEqual(['hero', 'faq'])
  expect(recipeBlocks('standard', [{ type: 'callout', appearance: { background: 'accent', width: 'wide', spacing: 'compact', motionIntent: 'subtle', logoTone: 'inverse' } }])[0]?.appearance).toEqual({ background: 'accent', width: 'wide', spacing: 'compact', motionIntent: 'subtle', logoTone: 'inverse' })
  expect(() => recipeBlocks('landing', ['faq'])).toThrow('visible Hero')
  expect(recipeBlocks('landing', ['callout', 'faq'], [hero]).map((block) => block.type)).toEqual(['callout', 'faq'])
  expect(() => recipeBlocks('landing', ['hero'], [{ id: '10000000-0000-4000-8000-000000000002', type: 'richText', body: 'No hero', hidden: false, appearance }])).toThrow('visible Hero')
  expect(() => recipeBlocks('article', ['hero'])).toThrow('not allowed')
  const stable = deterministicRecipeBlockID('10000000-0000-4000-8000-000000000009', 0, 'callout')
  expect(stable).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(deterministicRecipeBlockID('10000000-0000-4000-8000-000000000009', 0, 'callout')).toBe(stable)
})

test('recipe selections cover the contract without fabricating records or testimonial consent', () => {
  expect(blockCatalog.filter((item) => item.recipeable).map((item) => item.type).sort()).toEqual(Object.keys(BlockSchemas).sort())
  expect(recipeBlocks('standard', [{ type: 'pillarGrid' }, { type: 'cta' }]).map((block) => block.type)).toEqual(['pillarGrid', 'cta'])
  const references = recipeBlocks('standard', [
    { type: 'testimonials', fields: { items: [{ quote: 'A permitted testimonial.', attribution: 'Draft customer', permissionConfirmed: true }] } },
    { type: 'relatedServices', fields: { heading: 'Related services', pageIds: ['10000000-0000-4000-8000-000000000003'] } },
    { type: 'media', fields: { mediaId: '10000000-0000-4000-8000-000000000004' } },
    { type: 'imageText', fields: { mediaId: '10000000-0000-4000-8000-000000000005' } },
    { type: 'gallery', fields: { mediaIds: ['10000000-0000-4000-8000-000000000006'] } },
    { type: 'logoStrip', fields: { mediaIds: ['10000000-0000-4000-8000-000000000007'] } },
    { type: 'video', fields: { mediaId: '10000000-0000-4000-8000-000000000008', posterMediaId: '10000000-0000-4000-8000-000000000009', captionsMediaId: '10000000-0000-4000-8000-000000000010' } },
  ])
  expect(references.map((block) => block.type)).toEqual(['testimonials', 'relatedServices', 'media', 'imageText', 'gallery', 'logoStrip', 'video'])
  expect(recipeRequiredSelections).toMatchObject({ testimonials: ['items'], media: ['mediaId'], video: ['mediaId', 'posterMediaId', 'captionsMediaId'] })
  expect(() => recipeBlocks('standard', [{ type: 'testimonials' }])).toThrow()
  expect(() => recipeBlocks('standard', [{ type: 'testimonials', fields: { items: [{ quote: 'Unconfirmed testimonial.', attribution: 'Draft customer', permissionConfirmed: false }] } }])).toThrow()
  expect(() => recipeBlocks('standard', [{ type: 'media', fields: { mediaId: '10000000-0000-4000-8000-000000000004', hidden: true } }])).toThrow('cannot replace')
  expect(() => recipeBlocks('standard', [{ type: 'callout', appearance: { background: 'accent', unexpected: true } }])).toThrow()
  expect(() => recipeBlocks('standard', [{ type: 'callout', fields: { body: 'Text', unexpected: true } }])).toThrow()
})
