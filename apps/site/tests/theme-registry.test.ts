import { describe, expect, it } from 'vitest';
import { ThemeManifestSchema, type Block } from '@site-engine/contract';
import { neutralFixture } from '@site-engine/contract/fixtures';
import { compatibilityReport, getInstalledTheme, installedThemes, manifestDigest, parseThemeRegistry, projectThemeMotion, verifyThemeSelection } from '../scripts/theme-registry.mjs';
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
  it('projects foreign presets for the target renderer without changing frozen source content', () => {
    const snapshot = structuredClone(neutralFixture); const block = snapshot.pages[0]!.blocks[0]!;
    block.appearance = { ...block.appearance, motionIntent: 'signature', motionPreset: 'source-grid' };
    const sourceHash = manifestDigest(snapshot);
    const target = ThemeManifestSchema.parse({ ...manifest, name: 'target', motion: { presets: ['target-chapter', 'target-fade'], intentFallbacks: { signature: 'target-chapter', subtle: 'target-fade' } } });
    const switched = projectThemeMotion(block, target);
    expect(switched.block).not.toBe(block);
    expect(switched.block.appearance.motionPreset).toBe('target-chapter');
    expect(switched.motionPreset).toBe('target-chapter');
    expect(switched.action).toBe('intent-fallback');
    expect(block.appearance.motionPreset).toBe('source-grid');
    expect(manifestDigest(snapshot)).toBe(sourceHash);
    expect(projectThemeMotion({ ...block, appearance: { ...block.appearance, motionPreset: 'target-fade', motionIntent: 'subtle' } }, target).block.appearance.motionPreset).toBe('target-fade');
    const report = compatibilityReport(snapshot, target);
    expect(report.actions).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'intent-fallback', blockID: block.id, reason: 'unsupported-motion-preset' })]));
  });
  it('keeps standard still zones still even when their source preset is supported by the target', () => {
    const source = structuredClone(neutralFixture).pages[0]!.blocks[0]!;
    const contact = { ...source, type: 'contact' } as Block;
    contact.appearance = { ...contact.appearance, motionIntent: 'subtle', motionPreset: 'foreign-grid' };
    const target = ThemeManifestSchema.parse({ ...manifest, name: 'still-target', motion: { presets: ['fade'], intentFallbacks: { subtle: 'fade' } } });
    const projection = projectThemeMotion(contact, target);
    expect(projection.motionPreset).toBeUndefined();
    expect(projection.block.appearance.motionPreset).toBeUndefined();
    expect(projection.block.appearance.motionIntent).toBe('none');
    expect(projection).toMatchObject({ action: 'still', reason: 'motion-still-zone' });
  });
  it('projects an unsupported preset without a declared fallback to an explicit still intent', () => {
    const source = structuredClone(neutralFixture).pages[0]!.blocks[0]!;
    source.appearance = { ...source.appearance, motionIntent: 'signature', motionPreset: 'foreign-grid' };
    const target = ThemeManifestSchema.parse({ ...manifest, name: 'no-fallback-target', motion: { presets: ['fade'], intentFallbacks: {} } });
    const projection = projectThemeMotion(source, target);
    expect(projection.block.appearance).toMatchObject({ motionIntent: 'none' });
    expect(projection.block.appearance.motionPreset).toBeUndefined();
    expect(projection).toMatchObject({ action: 'still', reason: 'no-declared-motion-fallback' });
  });
});
