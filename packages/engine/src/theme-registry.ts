import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ThemeInstallSchema, ThemeSelectionSchema, SiteSnapshotSchema, ThemeManifestSchema, type Block, type ThemeManifest } from '@site-engine/contract';
import { resolveDeclaredMotionPreset, type ResolvedMotionPreset } from './motion.js';

const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value) ?? "null";
export const manifestDigest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');

export type InstalledTheme = { manifest: ReturnType<typeof ThemeManifestSchema.parse>; manifestDigest: string };
/** Themes are retained by immutable name/version identity. */
export type ThemeRegistry = Map<string, Map<string, InstalledTheme>>;

export function installedThemes(registry: ThemeRegistry): InstalledTheme[] {
  return [...registry.values()].flatMap((versions) => [...versions.values()]);
}

export function getInstalledTheme(registry: ThemeRegistry, name: string, version: string): InstalledTheme | undefined {
  return registry.get(name)?.get(version);
}

/** Parses operator data only; it never imports or executes a theme module. */
export function parseThemeRegistry(value: unknown): ThemeRegistry {
  const entries = Array.isArray(value) ? value : (value && typeof value === "object" && "themes" in value ? value.themes : undefined);
  if (!Array.isArray(entries)) throw new Error('Theme registry must contain a themes array.');
  const registry: ThemeRegistry = new Map();
  for (const entry of entries) {
    const installed = ThemeInstallSchema.parse(entry);
    const digest = manifestDigest(installed.manifest);
    const versions = registry.get(installed.manifest.name) ?? new Map<string, InstalledTheme>();
    if (versions.has(installed.manifest.version)) throw new Error('Theme registry contains duplicate install name/version pairs.');
    versions.set(installed.manifest.version, { manifest: installed.manifest, manifestDigest: digest });
    registry.set(installed.manifest.name, versions);
  }
  return registry;
}
export async function loadThemeRegistry(value = process.env.SITE_THEME_REGISTRY_JSON): Promise<ThemeRegistry> {
  if (!value) return new Map();
  const source = value.trim().startsWith('{') || value.trim().startsWith('[') ? value : await readFile(value, 'utf8');
  try { return parseThemeRegistry(JSON.parse(source)); } catch (error) { throw new Error(`Invalid theme registry: ${error instanceof Error ? error.message : 'unknown error'}`); }
}
export function verifyInstalledThemeSelection(input: unknown, registry: ThemeRegistry) {
  const selection = ThemeSelectionSchema.parse(input); const installed = getInstalledTheme(registry, selection.id, selection.version);
  if (!installed || installed.manifest.version !== selection.version || installed.manifest.contract !== selection.contract || installed.manifestDigest !== selection.manifestDigest) throw new Error('Frozen theme selection is not installed exactly as reviewed.');
  return installed;
}
export function verifyThemeSelection(snapshot: unknown, registry: ThemeRegistry) { const selection = SiteSnapshotSchema.parse(snapshot).settings.theme; return selection ? verifyInstalledThemeSelection(selection, registry) : undefined; }

export type MotionProjectionAction = 'intent-fallback' | 'still';
export type MotionProjection = { block: Block; motionPreset: ResolvedMotionPreset; action?: MotionProjectionAction; reason?: 'unsupported-motion-preset' | 'no-declared-motion-fallback' | 'motion-still-zone' };

/** Standard blocks that must remain still regardless of a theme's preset list. */
export const standardMotionStillZones = new Set<Block['type']>(['contact', 'incidentBar']);

/**
 * Creates a render-only block for a target theme. The source block is never
 * changed, which keeps a reviewed snapshot and its content hash immutable.
 * A target renderer consequently never receives a foreign explicit preset.
 */
export function projectThemeMotion(block: Block, manifest: Pick<ThemeManifest, 'motion'>): MotionProjection {
  const sourcePreset = block.appearance.motionPreset;
  const still = block.hidden || block.appearance.motionIntent === 'none' || standardMotionStillZones.has(block.type);
  const supported = new Set(manifest.motion?.presets ?? []);
  const fallbacks = new Map(Object.entries(manifest.motion?.intentFallbacks ?? {}));
  const motionPreset = still ? undefined : resolveDeclaredMotionPreset(block.appearance.motionIntent, sourcePreset, supported, fallbacks);
  const { motionPreset: _sourcePreset, ...appearance } = block.appearance;
  // Target renderers may derive their own default from intent. A still
  // projection must therefore carry `none`, not merely omit the preset.
  const projected = { ...block, appearance: { ...appearance, motionIntent: motionPreset ? block.appearance.motionIntent : 'none', ...(motionPreset ? { motionPreset } : {}) } } as Block;
  if (!sourcePreset || sourcePreset === motionPreset) return { block: projected, motionPreset };
  if (still) return { block: projected, motionPreset, action: 'still', reason: 'motion-still-zone' };
  return motionPreset
    ? { block: projected, motionPreset, action: 'intent-fallback', reason: 'unsupported-motion-preset' }
    : { block: projected, motionPreset, action: 'still', reason: 'no-declared-motion-fallback' };
}

export function compatibilityReport(snapshot: unknown, manifest: InstalledTheme["manifest"]) {
  const parsed = SiteSnapshotSchema.parse(snapshot);
  const supported = new Set(manifest.standardBlocks);
  const actions = [];
  if (manifest.contract !== parsed.settings.contractVersion) actions.push({ action: 'contract-version', pageID: '', blockID: '', reason: 'theme-contract-mismatch' });
  for (const page of parsed.pages) for (const block of page.blocks) {
    if (!supported.has(block.type)) actions.push({ action: 'hide', pageID: page.id, blockID: block.id, reason: 'unsupported-standard-block' });
    else {
      const projection = projectThemeMotion(block, manifest);
      if (projection.action) actions.push({ action: projection.action, pageID: page.id, blockID: block.id, reason: projection.reason });
      else if (block.appearance.motionIntent !== 'none' && !block.appearance.motionPreset && !manifest.motion?.intentFallbacks?.[block.appearance.motionIntent]) actions.push({ action: 'still', pageID: page.id, blockID: block.id, reason: 'no-declared-motion-fallback' });
    }
  }
  return { compatible: actions.every(item => item.action !== 'hide' && item.action !== 'contract-version'), actions };
}
