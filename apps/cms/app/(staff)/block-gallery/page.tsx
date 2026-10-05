import { getPayload } from 'payload'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import config from '../../../payload.config'
import { hasRole } from '../../../src/access'
import { blockCatalog, appearanceOptions } from '../../../src/block-gallery'
import { serverSessionStrategy } from '../../../src/identity'
import { StaffShell } from '../../components/staff-shell'
import { BlockGallery } from './block-gallery'
import { loadAdminBranding } from '../../../src/admin-branding'
import { loadInitialPreviewBaseline } from '../../../src/review-preview'
import { getInstalledTheme, loadThemeRegistry } from '@site-engine/engine/theme-registry'

export default async function BlockGalleryPage() {
  const payload = await getPayload({ config })
  const user = (await serverSessionStrategy.authenticate({ headers: await headers(), payload })).user
  if (!hasRole(user as never, ['owner', 'editor'])) redirect('/admin/login')
  const [pages, sets, baseline, branding, registry] = await Promise.all([
    payload.find({ collection: 'pages', limit: 0, pagination: false, depth: 0, draft: true, user, overrideAccess: false }),
    payload.find({ collection: 'change-sets', where: { and: [{ actor: { equals: user?.id } }, { state: { equals: 'open' } }] }, limit: 100, depth: 0, user, overrideAccess: false }),
    loadInitialPreviewBaseline(),
    loadAdminBranding(),
    loadThemeRegistry(),
  ])
  const selected = baseline?.manifest.settings.theme
  const themeName = selected?.id
  const themeVersion = selected?.version ?? baseline?.versions.themeVersion
  const installed = themeName && themeVersion ? getInstalledTheme(registry, themeName, themeVersion) : undefined
  const previewKey = themeName && themeVersion ? `${themeName}@${themeVersion}` : ''
  const usesBlock = (blocks: unknown, type: string) => Array.isArray(blocks) && blocks.some((block) => Boolean(block && typeof block === 'object' && 'type' in block && block.type === type))
  const usage = Object.fromEntries(blockCatalog.map(({ type }) => [type, pages.docs.filter((page) => usesBlock(page.blocks, type)).map((page) => ({ id: page.id, title: page.title }))]))
  return <StaffShell><BlockGallery catalog={blockCatalog} appearance={appearanceOptions} pages={pages.docs.map((page) => ({ id: page.id, title: page.title, template: page.template }))} changeSets={sets.docs.map((set) => ({ id: set.id, name: set.name, revision: Number(set.revision ?? 0) }))} usage={usage} theme={themeName && themeVersion ? { name: themeName, version: themeVersion, presets: installed?.manifest.motion?.presets ?? [] } : undefined} previews={previewKey ? branding.blockGalleryPreviews?.[previewKey] ?? {} : {}} /></StaffShell>
}
