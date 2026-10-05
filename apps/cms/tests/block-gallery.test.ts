import { expect, test } from 'vitest'
import { BlockSchemas, TemplateAllowedBlocks } from '@site-engine/contract'
import { blockCatalog, deterministicRecipeBlockID, recipeBlocks } from '../src/block-gallery'

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
