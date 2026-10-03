import { expect, test } from 'vitest'
import { BlockSchemas, TemplateAllowedBlocks } from '@site-engine/contract'
import { blockCatalog, recipeBlocks } from '../src/block-gallery'

test('block gallery represents every contract block and recipe validation follows template policy', () => {
  expect(blockCatalog.map((item) => item.type).sort()).toEqual(Object.keys(BlockSchemas).sort())
  for (const item of blockCatalog) expect(item.allowedTemplates).toEqual(expect.arrayContaining(Object.keys(TemplateAllowedBlocks).filter((template) => TemplateAllowedBlocks[template as keyof typeof TemplateAllowedBlocks].includes(item.type))))
  expect(recipeBlocks('landing', ['hero', 'faq']).map((block) => block.type)).toEqual(['hero', 'faq'])
  expect(() => recipeBlocks('landing', ['faq'])).toThrow('begin with Hero')
  expect(() => recipeBlocks('article', ['hero'])).toThrow('not allowed')
})
