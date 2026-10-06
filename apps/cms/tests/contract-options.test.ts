import { expect, test } from 'vitest'
import { AppearanceOptions, BackgroundSchema, CmsPageFieldConfig, LogoToneSchema, MotionIntentSchema, PageSchema, SpacingSchema, TemplateSchema, WidthSchema } from '@site-engine/contract'
import { Pages } from '../src/collections'
import { blockLibrary } from '../src/mcp'

function pageField(name: string): Record<string, unknown> {
  const field = (Pages.fields as Record<string, unknown>[]).find((candidate) => candidate.name === name)
  if (!field) throw new Error(`Missing Pages.${name} field`)
  return field
}

test('ENG-002 CMS field configuration derives page limits and template options from shared schemas', () => {
  expect(AppearanceOptions).toEqual({ backgrounds: BackgroundSchema.options, widths: WidthSchema.options, spacings: SpacingSchema.options, motionIntents: MotionIntentSchema.options, logoTones: LogoToneSchema.options })
  expect(blockLibrary.appearance).toBe(AppearanceOptions)
  expect(CmsPageFieldConfig.templateOptions).toEqual(TemplateSchema.options)
  expect(CmsPageFieldConfig.title).toEqual({ minLength: PageSchema.shape.title.minLength, maxLength: PageSchema.shape.title.maxLength })
  expect(CmsPageFieldConfig.summary).toEqual({ minLength: PageSchema.shape.summary.minLength, maxLength: PageSchema.shape.summary.maxLength })
  expect(CmsPageFieldConfig.kicker).toEqual({ maxLength: PageSchema.shape.kicker.unwrap().maxLength })
  expect(CmsPageFieldConfig.lede).toEqual({ maxLength: PageSchema.shape.lede.unwrap().maxLength })
  expect(CmsPageFieldConfig.seoDescription).toEqual({ maxLength: PageSchema.shape.seoDescription.unwrap().maxLength })
  expect(pageField('title')).toMatchObject(CmsPageFieldConfig.title)
  expect(pageField('summary')).toMatchObject({ minLength: 24, maxLength: CmsPageFieldConfig.summary.maxLength })
  expect(pageField('template').options).toEqual(TemplateSchema.options)
  expect(pageField('kicker')).toMatchObject(CmsPageFieldConfig.kicker)
  expect(pageField('lede')).toMatchObject(CmsPageFieldConfig.lede)
  expect(pageField('seoDescription')).toMatchObject(CmsPageFieldConfig.seoDescription)
})

test('ENG-002 contract boundaries accept and refuse the same title and summary maxima advertised by Pages', () => {
  for (const [name, schema] of Object.entries({ title: PageSchema.shape.title, summary: PageSchema.shape.summary, kicker: PageSchema.shape.kicker.unwrap(), lede: PageSchema.shape.lede.unwrap(), seoDescription: PageSchema.shape.seoDescription.unwrap() })) {
    const field = pageField(name)
    const maxLength = field.maxLength as number
    expect(schema.safeParse('x'.repeat(maxLength)).success).toBe(true)
    expect(schema.safeParse('x'.repeat(maxLength + 1)).success).toBe(false)
  }
  // The CMS asks for a fuller editorial listing summary, while the persisted
  // contract remains backward-compatible with one non-whitespace character.
  expect(PageSchema.shape.summary.safeParse('x').success).toBe(true)
  expect(pageField('summary').minLength).toBe(24)
})
