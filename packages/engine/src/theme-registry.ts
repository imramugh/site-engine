import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ThemeInstallSchema, ThemeSelectionSchema, SiteSnapshotSchema, ThemeManifestSchema } from '@site-engine/contract';

const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value) ?? "null";
const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');

export type InstalledTheme = { manifest: ReturnType<typeof ThemeManifestSchema.parse>; manifestDigest: string };
export type ThemeRegistry = Map<string, InstalledTheme>;

/** Parses operator data only; it never imports or executes a theme module. */
export function parseThemeRegistry(value: unknown): ThemeRegistry {
  const entries = Array.isArray(value) ? value : (value && typeof value === "object" && "themes" in value ? value.themes : undefined);
  if (!Array.isArray(entries)) throw new Error('Theme registry must contain a themes array.');
  const registry: ThemeRegistry = new Map();
  for (const entry of entries) {
    const installed = ThemeInstallSchema.parse(entry);
    const manifestDigest = digest(installed.manifest);
    if (registry.has(installed.manifest.name)) throw new Error('Theme registry contains duplicate install names.');
    registry.set(installed.manifest.name, { manifest: installed.manifest, manifestDigest });
  }
  return registry;
}
export async function loadThemeRegistry(value = process.env.SITE_THEME_REGISTRY_JSON): Promise<ThemeRegistry> {
  if (!value) return new Map();
  const source = value.trim().startsWith('{') || value.trim().startsWith('[') ? value : await readFile(value, 'utf8');
  try { return parseThemeRegistry(JSON.parse(source)); } catch (error) { throw new Error(`Invalid theme registry: ${error instanceof Error ? error.message : 'unknown error'}`); }
}
export function verifyInstalledThemeSelection(input: unknown, registry: ThemeRegistry) {
  const selection = ThemeSelectionSchema.parse(input); const installed = registry.get(selection.id);
  if (!installed || installed.manifest.version !== selection.version || installed.manifest.contract !== selection.contract || installed.manifestDigest !== selection.manifestDigest) throw new Error('Frozen theme selection is not installed exactly as reviewed.');
  return installed;
}
export function verifyThemeSelection(snapshot: unknown, registry: ThemeRegistry) { const selection = SiteSnapshotSchema.parse(snapshot).settings.theme; return selection ? verifyInstalledThemeSelection(selection, registry) : undefined; }
export function compatibilityReport(snapshot: unknown, manifest: InstalledTheme["manifest"]) {
  const parsed = SiteSnapshotSchema.parse(snapshot);
  const supported = new Set(manifest.standardBlocks);
  const fallback = manifest.motion?.intentFallbacks ?? {};
  const actions = [];
  for (const page of parsed.pages) for (const block of page.blocks) {
    if (!supported.has(block.type)) actions.push({ action: 'hide', pageID: page.id, blockID: block.id, reason: 'unsupported-standard-block' });
    else if (block.appearance.motionIntent !== 'none' && !block.appearance.motionPreset && !fallback[block.appearance.motionIntent]) actions.push({ action: 'intent-fallback', pageID: page.id, blockID: block.id, reason: 'no-declared-motion-fallback' });
  }
  return { compatible: actions.every(item => item.action !== 'hide'), actions };
}
