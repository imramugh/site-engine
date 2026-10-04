import { describe, expect, it } from 'vitest';
import { ThemeManifestSchema } from '@site-engine/contract';
import { neutralFixture } from '@site-engine/contract/fixtures';
import { compatibilityReport, getInstalledTheme, installedThemes, parseThemeRegistry, verifyThemeSelection } from '../scripts/theme-registry.mjs';
const manifest = ThemeManifestSchema.parse({ name: 'synthetic', version: '1.2.3', contract: '1.0.0', entry: './dist/renderer.js', standardBlocks: ['hero'], settingKeys: ['tone'], extensionBlocks: [], motion: { presets: [], intentFallbacks: {} } });
describe('operator theme registry', () => {
  it('validates manifests without executing code and binds frozen selection to an exact digest', () => {
    const registry = parseThemeRegistry({ themes: [{ manifest, installedAt: '2026-01-01T00:00:00.000Z' }] }); const selected = getInstalledTheme(registry, 'synthetic', manifest.version)!;
    const snapshot = structuredClone(neutralFixture); snapshot.settings.theme = { id: 'synthetic', version: manifest.version, contract: manifest.contract, manifestDigest: selected.manifestDigest };
    expect(verifyThemeSelection(snapshot, registry)).toEqual(selected);
    snapshot.settings.theme.manifestDigest = '0'.repeat(64); expect(() => verifyThemeSelection(snapshot, registry)).toThrow(/exactly/);
  });
  it('retains multiple immutable versions under one theme name', () => {
    const older = { ...manifest, version: '1.2.2' };
    const registry = parseThemeRegistry({ themes: [{ manifest: older, installedAt: '2026-01-01T00:00:00.000Z' }, { manifest, installedAt: '2026-01-02T00:00:00.000Z' }] });
    expect(installedThemes(registry).map((theme) => theme.manifest.version)).toEqual(['1.2.2', '1.2.3']);
    expect(getInstalledTheme(registry, manifest.name, older.version)?.manifestDigest).not.toBe(getInstalledTheme(registry, manifest.name, manifest.version)?.manifestDigest);
  });
  it('reports unsupported blocks and missing motion fallbacks using synthetic content', () => {
    const report = compatibilityReport(neutralFixture, manifest); expect(report.compatible).toBe(false); expect(report.actions.some(item => item.action === 'hide')).toBe(true);
  });
  it('requires the selected renderer contract to match the frozen snapshot', () => {
    const snapshot = structuredClone(neutralFixture); snapshot.settings.contractVersion = '1.1.0';
    const report = compatibilityReport(snapshot, manifest);
    expect(report.compatible).toBe(false);
    expect(report.actions).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'contract-version', reason: 'theme-contract-mismatch' })]));
  });
});
