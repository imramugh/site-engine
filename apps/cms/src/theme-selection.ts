import { SiteSnapshotSchema } from '@site-engine/contract'
import { compatibilityReport, type InstalledTheme } from '@site-engine/engine/theme-registry'

export type ThemeSelection = { id: string; version: string; contract: string; manifestDigest: string }

/** Build the exact reviewed snapshot used when choosing an installed theme.
 * A theme selection is the one draft operation that can advance the contract
 * pin, so compatibility must evaluate this candidate rather than the frozen
 * predecessor. */
export function selectionCandidate(manifest: unknown, selection: ThemeSelection) {
  const snapshot = SiteSnapshotSchema.parse(manifest)
  const hasHeroExtensions = snapshot.pages.some((page) => page.blocks.some((block) => block.type === 'hero' && (block.secondaryCta || block.supportPanel)))
  if (snapshot.settings.contractVersion === '1.1.0' && selection.contract === '1.0.0' && hasHeroExtensions) {
    throw new Error('This theme would downgrade a snapshot that uses Hero supporting content.')
  }
  return SiteSnapshotSchema.parse({ ...snapshot, settings: { ...snapshot.settings, contractVersion: selection.contract, theme: selection } })
}

export function compatibilityForTheme(manifest: unknown, installed: InstalledTheme) {
  const selection: ThemeSelection = { id: installed.manifest.name, version: installed.manifest.version, contract: installed.manifest.contract, manifestDigest: installed.manifestDigest }
  try { return compatibilityReport(selectionCandidate(manifest, selection), installed.manifest) }
  catch { return { compatible: false, actions: [{ action: 'contract-version', pageID: '', blockID: '', reason: 'theme-contract-transition-invalid' }] } }
}
