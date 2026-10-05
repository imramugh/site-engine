import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadAdminBranding, parseAdminBranding } from '../src/admin-branding'
import { adminSiteNavigationItems, navigationForRoles } from '../src/admin-navigation'

describe('ENG-006 / ENG-022 admin shell contracts', () => {
  it('keeps role discovery separate from route authorization', () => {
    expect(navigationForRoles(['owner']).map((item) => item.href)).toEqual(['/admin', '/content-tree', '/block-gallery', '/media', '/leads', '/applications', '/editorial', '/operations'])
    expect(navigationForRoles(['editor']).map((item) => item.href)).toContain('/content-tree')
    expect(navigationForRoles(['approver']).map((item) => item.href)).not.toContain('/block-gallery')
    expect(navigationForRoles(['sales']).map((item) => item.href)).toEqual(['/admin', '/leads'])
    expect(navigationForRoles(['hiring']).map((item) => item.href)).toEqual(['/admin', '/applications'])
    expect(navigationForRoles(['owner'], adminSiteNavigationItems).map((item) => [item.label, item.href])).toEqual([
      ['Site', '/site'], ['Integrations', '/integrations'], ['Users', '/users'],
    ])
    expect(navigationForRoles(['editor'], adminSiteNavigationItems)).toEqual([])
  })

  it('uses neutral branding for missing or unsafe manifests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'admin-branding-'))
    expect(await loadAdminBranding(directory)).toMatchObject({ name: 'Site workspace', initials: 'SW', tokens: {} })
    await writeFile(join(directory, 'branding.json'), JSON.stringify({ name: 'Private', initials: 'P', logoUrl: 'https://example.test/logo.svg', tokens: { '--admin-accent': 'url(javascript:bad)' } }))
    expect(await loadAdminBranding(directory)).toMatchObject({ name: 'Private', initials: 'P', tokens: {} })
    expect(parseAdminBranding({ name: 'Private', initials: 'P', logoUrl: '/admin-branding/assets/logo.svg', tokens: { '--admin-accent': '#123456', '--untrusted': '#fff' } })).toEqual({ name: 'Private', initials: 'P', logoUrl: '/admin-branding/assets/logo.svg', stylesheetUrl: '/admin-branding/admin-branding.css', tokens: { '--admin-accent': '#123456' } })
    expect(parseAdminBranding({ name: 'Private', initials: 'P', blockGalleryPreviews: { 'theme@1.2.3': { hero: '/admin-branding/assets/block-gallery/theme@1.2.3/hero.png', '<script>': '/admin-branding/assets/bad.png', faq: 'https://example.test/bad.png' }, '../bad@1.2.3': { hero: '/admin-branding/assets/bad.png' } } }).blockGalleryPreviews).toEqual({ 'theme@1.2.3': { hero: '/admin-branding/assets/block-gallery/theme@1.2.3/hero.png' } })
  })
})
