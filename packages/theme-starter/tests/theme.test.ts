import { describe, expect, it } from 'vitest';
import { starterTheme, validateStarterTheme } from '../src/index.js';
describe('ENG-038 starter theme descriptor', () => {
  it('covers the public contract surface', () => expect(validateStarterTheme(starterTheme)).toEqual([]));
  it('reports an incomplete theme', () => expect(validateStarterTheme({ ...starterTheme, supportedBlocks: [] })).toContain('Missing block hero'));
  it('requires declared motion presets', () => expect(validateStarterTheme({ ...starterTheme, motion: { supportedPresets: [], intentFallbacks: {} } })).toContain('Missing motion presets'));
});
