import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { deriveRoutes, resolveSiteNavigation } from '@site-engine/engine'
import { buildCandidate, canonicalHash } from '../src/publishing'
import { snapshotMediaReference } from '../src/media'
import sharp from 'sharp'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-site-settings-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-reviewed-site-settings'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

describe('reviewed site settings singleton', () => {
  it('canonicalizes baseline semantic logo references across unrelated edits and rejects unknown assets without mutating the baseline', () => {
    const base = structuredClone(neutralFixture)
    base.settings.contractVersion = '1.5.0'
    const assets = Array.from({ length: 5 }, (_, index) => ({ id: randomUUID(), filename: `semantic-${index}.svg`, mimeType: 'image/svg+xml' as const, width: 100, height: 20, alt: `Semantic logo ${index + 1}`, decorative: false }))
    base.media = assets
    base.settings.logos = {
      primaryLight: { ...assets[0]!, sha256: '0'.repeat(64) }, primaryDark: assets[1]!,
      fullLockupLight: assets[2]!, fullLockupDark: assets[3]!,
      symbolLight: assets[4]!, symbolDark: assets[4]!,
    }
    const page = base.pages[0]!
    const updatedPage = { ...page, blocks: page.blocks.map((block, index) => index === 0 ? { ...block, heading: 'An unrelated reviewed block edit' } : block) }
    const pageCandidate = buildCandidate(base, [{ collection: 'pages', id: page.id, before: page, after: updatedPage, beforeHash: canonicalHash(page), afterHash: canonicalHash(updatedPage) }] as never, [`pages:${page.id}`], { themeVersion: '1.0.0', engineVersion: 'test', contractVersion: '1.5.0' })
    expect(pageCandidate.settings.logos).toEqual({
      primaryLight: assets[0], primaryDark: assets[1], fullLockupLight: assets[2], fullLockupDark: assets[3], symbolLight: assets[4], symbolDark: assets[4],
    })

    const capturedLogos = Object.fromEntries(Object.entries(base.settings.logos).map(([field, asset]) => [field, asset.id]))
    const clearLogos = { collection: 'site-settings', id: 'active', before: { logos: capturedLogos }, after: {}, beforeHash: canonicalHash({ logos: capturedLogos }), afterHash: canonicalHash({}) }
    expect(buildCandidate(base, [clearLogos] as never, ['site-settings:active'], { themeVersion: '1.0.0', engineVersion: 'test', contractVersion: '1.5.0' }).settings.logos).toBeUndefined()

    const before = canonicalHash(base)
    const unknownLogos = { collection: 'site-settings', id: 'active', before: { logos: capturedLogos }, after: { logos: { primaryLight: randomUUID() } }, beforeHash: canonicalHash({ logos: capturedLogos }), afterHash: null }
    expect(() => buildCandidate(base, [unknownLogos] as never, ['site-settings:active'], { themeVersion: '1.0.0', engineVersion: 'test', contractVersion: '1.5.0' })).toThrow('semantic logo primaryLight must reference an included asset')
    expect(canonicalHash(base)).toBe(before)
  })
  it('replaces the homepage without redirecting the root away from the reviewed page', () => {
    const base = structuredClone(neutralFixture)
    const previous = base.pages[0]!
    base.settings.homepageId = previous.id
    const replacement = { ...structuredClone(previous), id: randomUUID(), slug: 'replacement', title: 'Reviewed replacement homepage' }
    base.pages.push(replacement)
    base.settings.sections[0]!.pageIds.push(replacement.id)
    base.redirects = [{ from: '/legacy-home', to: '/', status: 301 }]
    const formerReplacementPath = deriveRoutes(base).routes.find(route => route.page.id === replacement.id)!.path
    const candidate = buildCandidate(base, [{ collection: 'site-settings', id: 'active', before: null, after: { homepageId: replacement.id }, beforeHash: null, afterHash: null }], ['site-settings:active'], { themeVersion: '1.0.0', engineVersion: '1.0.0', contractVersion: '1.0.0' })
    expect(deriveRoutes(candidate).routes.find(route => route.path === '/')?.page.id).toBe(replacement.id)
    expect(candidate.redirects.some(redirect => redirect.from === '/')).toBe(false)
    expect(candidate.redirects).toContainEqual({ from: '/legacy-home', to: '/', status: 301 })
    expect(candidate.redirects).toContainEqual({ from: formerReplacementPath, to: '/', status: 301 })
    expect(base.settings.homepageId).toBe(previous.id)
  })
  it('lets only an Owner capture settings and applies them to a frozen candidate without changing its baseline', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `settings-owner-${randomUUID()}@example.test`, name: 'Settings owner', roles: ['owner'] }, overrideAccess: true })
    const editor = await payload.create({ collection: 'users', data: { email: `settings-editor-${randomUUID()}@example.test`, name: 'Settings editor', roles: ['editor'] }, overrideAccess: true })
    const base = structuredClone(neutralFixture); base.settings.contractVersion = '1.7.0'; const sectionID = randomUUID(); const pageID = randomUUID()
    base.settings.sections[0]!.id = sectionID; base.settings.sections[0]!.pageIds = [pageID]; base.pages[0]!.id = pageID; base.pages[0]!.sectionId = sectionID; base.settings.homepageId = pageID
    await payload.create({ collection: 'sections', data: { id: sectionID, name: base.settings.sections[0]!.name, summary: base.settings.sections[0]!.summary ?? 'Synthetic section retained for reviewed settings.', slug: base.settings.sections[0]!.slug, allowedTemplates: base.settings.sections[0]!.allowedTemplates }, overrideAccess: true })
    await payload.create({ collection: 'pages', data: { id: pageID, sectionId: sectionID, title: base.pages[0]!.title, summary: base.pages[0]!.summary, slug: base.pages[0]!.slug, template: 'landing', blocks: base.pages[0]!.blocks }, overrideAccess: true })
    const image = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#123456' } }).png().toBuffer()
    const asset = await payload.create({ collection: 'assets', data: { alt: 'Reviewed semantic identity' }, file: { data: image, mimetype: 'image/png', name: `identity-${randomUUID()}.png`, size: image.length }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    base.media.push(snapshotMediaReference(asset as never, true) as (typeof base.media)[number])
    const navigation = { header: [{ kind: 'page' as const, id: pageID, label: 'Home', style: 'link' as const }], footer: { columns: [{ heading: 'Company', links: [{ kind: 'section' as const, id: sectionID, label: 'General' }] }], copyright: '© {year} Reviewed Settings Studio' } }
    const crawlerPolicy = { searchEngines: true, aiSearchAndAnswers: false, aiModelTraining: false }
    const settings = await payload.create({ collection: 'site-settings', data: { siteName: 'Reviewed Settings Studio', legalName: 'Reviewed Settings Studio Incorporated', homepageId: pageID, defaultLocale: 'en-CA', organizationType: 'professional-service', logos: { primaryLight: asset.id, symbolDark: asset.id }, contactEmail: 'hello@example.test', contactPhone: '+1 555 0100', address: { streetAddress: '100 Example Road', addressLocality: 'Example City', addressRegion: 'ON', postalCode: 'A1A 1A1', addressCountry: 'CA' }, linkedIn: 'https://www.linkedin.com/company/reviewed-settings-studio', incident: { label: 'Incident in progress?', guidance: 'Call the incident line and preserve affected systems.' }, navigation, seoDescription: 'A reviewed synthetic description.', searchEnabled: true, crawlerPolicy }, draft: true, user: owner, overrideAccess: false })
    await expect(payload.update({ collection: 'site-settings', id: settings.id, data: { siteName: 'Denied' }, user: editor, overrideAccess: false })).rejects.toThrow()
    await expect(payload.update({ collection: 'site-settings', id: settings.id, data: { contractVersion: '9.9.9' }, user: owner, overrideAccess: false })).rejects.toThrow(/not editable/)
    const sets = await payload.find({ collection: 'change-sets', where: { actor: { equals: owner.id } }, overrideAccess: true, depth: 0 })
    const change = (sets.docs[0]!.changes as Array<{ collection: string; id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; beforeHash: string | null; afterHash: string | null }>).find((item) => item.collection === 'site-settings')!
    const candidate = buildCandidate(base, [change] as never, [`site-settings:${change.id}`], { themeVersion: '1.0.0', engineVersion: '1.0.0', contractVersion: '1.0.0' })
    expect(candidate.settings).toMatchObject({ siteName: 'Reviewed Settings Studio', legalName: 'Reviewed Settings Studio Incorporated', homepageId: pageID, defaultLocale: 'en-CA', organizationType: 'professional-service', logos: { primaryLight: { id: asset.id }, symbolDark: { id: asset.id } }, address: { addressCountry: 'CA' }, linkedIn: 'https://www.linkedin.com/company/reviewed-settings-studio', incident: { label: 'Incident in progress?' }, navigation, seoDescription: 'A reviewed synthetic description.', searchEnabled: true, crawlerPolicy })
    await expect(payload.update({ collection: 'site-settings', id: settings.id, data: { navigation: { ...navigation, header: [{ kind: 'page', id: randomUUID(), label: 'Missing', style: 'link' }] } }, draft: true, user: owner, overrideAccess: false })).rejects.toThrow(/unavailable page/)
    expect(base.settings.siteName).toBe('Sample Studio')
    await payload.update({ collection: 'change-sets', id: sets.docs[0]!.id, data: { state: 'discarded' }, overrideAccess: true, context: { editorialInternal: true } })
    await payload.delete({ collection: 'site-settings', id: settings.id, overrideAccess: true, context: { editorialInternal: true } })
  })
  it('treats database nulls as portable omissions when an imported singleton gains its first optional value', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `settings-import-owner-${randomUUID()}@example.test`, name: 'Imported settings owner', roles: ['owner'] }, overrideAccess: true })
    const base = structuredClone(neutralFixture); base.settings.contractVersion = '1.5.0'
    const settings = await payload.create({ collection: 'site-settings', data: { key: 'active', siteName: base.settings.siteName, defaultLocale: base.settings.defaultLocale }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    await payload.update({ collection: 'site-settings', id: settings.id, data: { legalName: 'First reviewed legal name' }, draft: true, user: owner, overrideAccess: false })
    const sets = await payload.find({ collection: 'change-sets', where: { actor: { equals: owner.id } }, limit: 1, overrideAccess: true, depth: 0 })
    const change = (sets.docs[0]!.changes as Array<{ collection: string; id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; beforeHash: string | null; afterHash: string | null }>).find(item => item.collection === 'site-settings')!
    expect(change.before).not.toHaveProperty('legalName')
    expect(buildCandidate(base, [change] as never, [`site-settings:${change.id}`], { themeVersion: '1.5.0', engineVersion: '1.0.0', contractVersion: '1.5.0' }).settings.legalName).toBe('First reviewed legal name')
    await payload.delete({ collection: 'site-settings', id: settings.id, overrideAccess: true, context: { editorialInternal: true } })
  })
  it('captures reordered 1.6 navigation and resolves only visible generated pillars from SQLite-backed content', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `navigation-owner-${randomUUID()}@example.test`, name: 'Navigation owner', roles: ['owner'] }, overrideAccess: true })
    const sectionID = randomUUID(), homeID = randomUUID(), firstID = randomUUID(), secondID = randomUUID(), nestedID = randomUUID(), draftID = randomUUID()
    const section = await payload.create({ collection: 'sections', data: { id: sectionID, name: 'Services', summary: 'Synthetic generated navigation section.', slug: `services-${sectionID.slice(0, 8)}`, allowedTemplates: ['landing', 'pillar'] }, overrideAccess: true })
    const page = (id: string, title: string, slug: string, template: 'landing' | 'pillar', parentId?: string) => payload.create({ collection: 'pages', data: { id, sectionId: sectionID, parentId, title, summary: `${title} summary for generated navigation.`, slug, template, blocks: template === 'landing' ? structuredClone(neutralFixture.pages[0]!.blocks) : [] }, draft: true, overrideAccess: true })
    await page(homeID, 'Home', 'home', 'landing'); await page(firstID, 'First pillar', 'first', 'pillar', homeID); await page(secondID, 'Second pillar', 'second', 'pillar', homeID); await page(nestedID, 'Nested pillar', 'nested', 'pillar', firstID); await page(draftID, 'Draft pillar', 'draft', 'pillar', homeID)
    await payload.update({ collection: 'sections', id: section.id, data: { landingPageId: homeID, pageIds: [secondID, nestedID, draftID, firstID, homeID] }, draft: true, overrideAccess: true })
    const base = structuredClone(neutralFixture); base.settings.contractVersion = '1.6.0'; base.settings.sections = [{ id: sectionID, name: 'Services', summary: 'Synthetic generated navigation section.', slug: `services-${sectionID.slice(0, 8)}`, allowedTemplates: ['landing', 'pillar'], landingPageId: homeID, pageIds: [secondID, nestedID, draftID, firstID, homeID] }]; base.settings.homepageId = homeID
    const source = structuredClone(base.pages[0]!); base.pages = [
      { ...source, id: homeID, sectionId: sectionID, title: 'Home', slug: 'home', template: 'landing', status: 'published' },
      { ...source, id: firstID, sectionId: sectionID, parentId: homeID, title: 'First pillar', slug: 'first', template: 'pillar', status: 'published', blocks: [] },
      { ...source, id: secondID, sectionId: sectionID, parentId: homeID, title: 'Second pillar', slug: 'second', template: 'pillar', status: 'published', blocks: [] },
      { ...source, id: nestedID, sectionId: sectionID, parentId: firstID, title: 'Nested pillar', slug: 'nested', template: 'pillar', status: 'published', blocks: [] },
      { ...source, id: draftID, sectionId: sectionID, parentId: homeID, title: 'Draft pillar', slug: 'draft', template: 'pillar', status: 'draft', blocks: [] },
    ]
    const navigation = { header: [{ kind: 'page' as const, id: secondID, label: 'Second', style: 'link' as const }, { kind: 'unavailable' as const, label: 'Insights', reason: 'Insights are not published.', style: 'link' as const }, { kind: 'page' as const, id: homeID, label: 'Home', style: 'button' as const }], footer: { columns: [{ kind: 'section-pillars' as const, heading: 'Services', sectionId: sectionID }, { kind: 'contact' as const, heading: 'Contact', fields: ['email' as const, 'address' as const] }], bottomLinks: [{ kind: 'unavailable' as const, label: 'Privacy', reason: 'Privacy is not published.' }], copyright: '© {year} Navigation Studio' } }
    await payload.create({ collection: 'site-settings', data: { key: 'active', siteName: 'Navigation Studio', homepageId: homeID, defaultLocale: 'en-CA', contactEmail: 'hello@example.test', navigation }, draft: true, user: owner, overrideAccess: false })
    const sets = await payload.find({ collection: 'change-sets', where: { actor: { equals: owner.id } }, limit: 1, sort: '-createdAt', overrideAccess: true, depth: 0 })
    const change = (sets.docs[0]!.changes as Array<{ collection: string; id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>).find(item => item.collection === 'site-settings')!
    const candidate = buildCandidate(base, [change] as never, [`site-settings:${change.id}`], { themeVersion: '1.6.0', engineVersion: 'test', contractVersion: '1.6.0' })
    expect(candidate.settings.navigation?.header.map(item => item.label)).toEqual(['Second', 'Insights', 'Home'])
    expect(resolveSiteNavigation(candidate, 2032).footer.columns[0]).toMatchObject({ kind: 'section-pillars', items: [{ label: 'Second pillar' }, { label: 'First pillar' }] })
    expect(resolveSiteNavigation(candidate, 2032).footer.columns[1]).toMatchObject({ kind: 'contact', items: [{ field: 'email' }] })
    expect(resolveSiteNavigation(candidate, 2032).footer.copyright).toBe('© 2032 Navigation Studio')
  })
})
