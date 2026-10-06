import { getPayload } from 'payload'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import config from '../../../payload.config'
import { hasRole } from '../../../src/access'
import { appearanceOptions } from '../../../src/block-gallery'
import { galleryCatalog, sectionPresetCatalog, templateCatalog } from '../../../src/block-gallery-catalog'
import { serverSessionStrategy } from '../../../src/identity'
import { StaffShell } from '../../components/staff-shell'
import { BlockGallery } from './block-gallery'
import { exactGalleryLibrary, loadAdminBranding } from '../../../src/admin-branding'
import { loadPublishedPreviewBaseline } from '../../../src/review-preview'
import { getInstalledTheme, loadThemeRegistry } from '@site-engine/engine/theme-registry'

export default async function BlockGalleryPage() {
  const payload = await getPayload({ config })
  const user = (await serverSessionStrategy.authenticate({ headers: await headers(), payload })).user
  if (!hasRole(user as never, ['owner', 'editor'])) redirect('/admin/login')
  const [pages, sets, baseline, branding, registry, assets] = await Promise.all([
    payload.find({ collection: 'pages', where: { status: { not_equals: 'archived' } }, limit: 0, pagination: false, depth: 0, draft: true, user, overrideAccess: false }),
    payload.find({ collection: 'change-sets', where: { and: [{ actor: { equals: user?.id } }, { state: { equals: 'open' } }] }, limit: 100, depth: 0, user, overrideAccess: false }),
    loadPublishedPreviewBaseline(payload),
    loadAdminBranding(),
    loadThemeRegistry(),
    payload.find({ collection: 'assets', where: { deletedAt: { exists: false } }, limit: 0, pagination: false, depth: 0, user, overrideAccess: false }),
  ])
  const selected = baseline?.manifest.settings.theme
  const themeName = selected?.id
  const themeVersion = selected?.version ?? baseline?.versions.themeVersion
  const candidate = themeName && themeVersion ? getInstalledTheme(registry, themeName, themeVersion) : undefined
  const installed = candidate && candidate.manifestDigest === selected?.manifestDigest && candidate.manifest.contract === selected?.contract ? candidate : undefined
  const previewKey = installed && themeName && themeVersion ? `${themeName}@${themeVersion}` : ''
  const library = exactGalleryLibrary(branding.blockGalleryLibraries, installed ? { ...installed.manifest, manifestDigest: installed.manifestDigest } : undefined)
  const usesBlock = (blocks: unknown, type: string) => Array.isArray(blocks) && blocks.some((block) => Boolean(block && typeof block === 'object' && 'type' in block && block.type === type))
  const usage = Object.fromEntries(galleryCatalog.map(({ type }) => [type, pages.docs.filter((page) => usesBlock(page.blocks, type)).map((page) => ({ id: page.id, title: page.title }))]))
  return <StaffShell><BlockGallery catalog={galleryCatalog} templates={templateCatalog} sectionPresets={sectionPresetCatalog} assets={assets.docs.map(asset => ({ id: String(asset.id), label: asset.filename ?? asset.alt ?? 'Media', mimeType: asset.mimeType ?? '' }))} appearance={appearanceOptions} pages={pages.docs.map((page) => ({ id: page.id, title: page.title, template: page.template }))} changeSets={sets.docs.map((set) => ({ id: set.id, name: set.name, revision: Number(set.revision ?? 0) }))} usage={usage} theme={themeName && themeVersion ? { name: themeName, version: themeVersion, presets: installed?.manifest.motion?.presets ?? [], extensions: installed?.manifest.extensionBlocks ?? [] } : undefined} library={library} previews={library && previewKey ? branding.blockGalleryPreviews?.[previewKey] ?? {} : {}} /></StaffShell>
}
