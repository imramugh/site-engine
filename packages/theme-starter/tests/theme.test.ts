import { describe, expect, it } from 'vitest';
import { starterTheme, themeCanRender, validateStarterTheme } from '../src/index.js';
import { neutralFixture } from '@site-engine/contract/fixtures';
describe('ENG-038 starter theme descriptor', () => {
  it('covers the public contract surface', () => expect(validateStarterTheme(starterTheme)).toEqual([]));
  it('reports an incomplete theme', () => expect(validateStarterTheme({ ...starterTheme, supportedBlocks: [] })).toContain('Missing block hero'));
  it('requires declared motion presets', () => expect(validateStarterTheme({ ...starterTheme, motion: { supportedPresets: [], intentFallbacks: {} } })).toContain('Missing motion presets'));
  it('renders frozen 1.0 snapshots as well as current 1.1 snapshots', () => {
    expect(themeCanRender(neutralFixture)).toBe(true);
    const current = structuredClone(neutralFixture); current.settings.contractVersion = '1.1.0';
    expect(themeCanRender(current)).toBe(true);
  });
});
