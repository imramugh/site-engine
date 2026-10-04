import { expect, test } from 'vitest'
import { AppearanceOptions, BackgroundSchema, LogoToneSchema, MotionIntentSchema, SpacingSchema, WidthSchema } from '@site-engine/contract'
import { blockLibrary } from '../src/mcp'

test('ENG-002 CMS contract discovery derives every appearance option from shared schemas', () => {
  expect(AppearanceOptions).toEqual({ backgrounds: BackgroundSchema.options, widths: WidthSchema.options, spacings: SpacingSchema.options, motionIntents: MotionIntentSchema.options, logoTones: LogoToneSchema.options })
  expect(blockLibrary.appearance).toBe(AppearanceOptions)
})
