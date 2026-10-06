import { describe, expect, it } from 'vitest';
import { AppearanceOptions } from '@site-engine/contract';
import { starterTheme, themeCanRender, validateStarterTheme } from '../src/index.js';
import { neutralFixture } from '@site-engine/contract/fixtures';
describe('ENG-038 starter theme descriptor', () => {
  it('covers the public contract surface', () => expect(validateStarterTheme(starterTheme)).toEqual([]));
  it('derives its visual choices from the contract options', () => {
    expect(starterTheme.backgrounds).toEqual(AppearanceOptions.backgrounds);
    expect(starterTheme.appearance?.widths).toEqual(AppearanceOptions.widths);
    expect(starterTheme.appearance?.spacings).toEqual(AppearanceOptions.spacings);
    expect(starterTheme.appearance?.logoTones).toEqual(AppearanceOptions.logoTones);
  });
  it('reports an incomplete theme', () => expect(validateStarterTheme({ ...starterTheme, supportedBlocks: [] })).toContain('Missing block hero'));
  it('requires declared motion presets', () => expect(validateStarterTheme({ ...starterTheme, motion: { supportedPresets: [], intentFallbacks: {} } })).toContain('Missing motion presets'));
  it('reports an omitted contract logo tone', () => expect(validateStarterTheme({ ...starterTheme, appearance: { ...starterTheme.appearance!, logoTones: ['default'] } })).toContain('Missing logo tone inverse'));
  it('renders frozen contracts as well as the current 1.7 snapshot contract', () => {
    expect(themeCanRender(neutralFixture)).toBe(true);
    const current = structuredClone(neutralFixture); current.settings.contractVersion = '1.7.0';
    expect(themeCanRender(current)).toBe(true);
  });
});
