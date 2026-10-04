import { expect, test } from 'vitest'
import { BlockSchemas, TemplateAllowedBlocks } from '@site-engine/contract'
import { blockCatalog, recipeBlocks } from '../src/block-gallery'

const appearance = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' }
const hero = { id: '10000000-0000-4000-8000-000000000001', type: 'hero', heading: 'Existing hero', body: 'Existing landing content.', hidden: false, appearance }

test('block gallery represents every contract block and recipe validation follows template policy', () => {
  expect(blockCatalog.map((item) => item.type).sort()).toEqual(Object.keys(BlockSchemas).sort())
  for (const item of blockCatalog) expect(item.allowedTemplates).toEqual(expect.arrayContaining(Object.keys(TemplateAllowedBlocks).filter((template) => TemplateAllowedBlocks[template as keyof typeof TemplateAllowedBlocks].includes(item.type))))
  expect(recipeBlocks('landing', ['hero', 'faq']).map((block) => block.type)).toEqual(['hero', 'faq'])
  expect(() => recipeBlocks('landing', ['faq'])).toThrow('visible Hero')
  expect(recipeBlocks('landing', ['callout', 'faq'], [hero]).map((block) => block.type)).toEqual(['callout', 'faq'])
  expect(() => recipeBlocks('landing', ['hero'], [{ id: '10000000-0000-4000-8000-000000000002', type: 'richText', body: 'No hero', hidden: false, appearance }])).toThrow('visible Hero')
  expect(() => recipeBlocks('article', ['hero'])).toThrow('not allowed')
})
