import { describe, expect, it } from 'vitest';
import { neutralFixture } from '@site-engine/contract/fixtures';
import { compatibilityReport, parseThemeRegistry, verifyThemeSelection } from '../scripts/theme-registry.mjs';
const manifest = { name: 'synthetic', version: '1.2.3', contract: '1.0.0', entry: './dist/renderer.js', standardBlocks: ['hero'], settingKeys: ['tone'], extensionBlocks: [], motion: { presets: [], intentFallbacks: {} } };
describe('operator theme registry', () => {
  it('validates manifests without executing code and binds frozen selection to an exact digest', () => {
    const registry = parseThemeRegistry({ themes: [{ manifest, installedAt: '2026-01-01T00:00:00.000Z' }] }); const selected = registry.get('synthetic');
    const snapshot = structuredClone(neutralFixture); snapshot.settings.theme = { id: 'synthetic', version: manifest.version, contract: manifest.contract, manifestDigest: selected.manifestDigest };
    expect(verifyThemeSelection(snapshot, registry)).toEqual(selected);
    snapshot.settings.theme.manifestDigest = '0'.repeat(64); expect(() => verifyThemeSelection(snapshot, registry)).toThrow(/exactly/);
  });
  it('reports unsupported blocks and missing motion fallbacks using synthetic content', () => {
    const report = compatibilityReport(neutralFixture, manifest); expect(report.compatible).toBe(false); expect(report.actions.some(item => item.action === 'hide')).toBe(true);
  });
});
