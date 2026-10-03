import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { buildCandidate } from '../src/publishing'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-site-settings-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-reviewed-site-settings'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

describe('reviewed site settings singleton', () => {
  it('lets only an Owner capture settings and applies them to a frozen candidate without changing its baseline', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `settings-owner-${randomUUID()}@example.test`, name: 'Settings owner', roles: ['owner'] }, overrideAccess: true })
    const editor = await payload.create({ collection: 'users', data: { email: `settings-editor-${randomUUID()}@example.test`, name: 'Settings editor', roles: ['editor'] }, overrideAccess: true })
    const base = structuredClone(neutralFixture); const sectionID = randomUUID(); const pageID = randomUUID()
    base.settings.sections[0]!.id = sectionID; base.settings.sections[0]!.pageIds = [pageID]; base.pages[0]!.id = pageID; base.pages[0]!.sectionId = sectionID; base.settings.homepageId = pageID
    await payload.create({ collection: 'sections', data: { id: sectionID, name: base.settings.sections[0]!.name, summary: base.settings.sections[0]!.summary ?? 'Synthetic section retained for reviewed settings.', slug: base.settings.sections[0]!.slug, allowedTemplates: base.settings.sections[0]!.allowedTemplates }, overrideAccess: true })
    await payload.create({ collection: 'pages', data: { id: pageID, sectionId: sectionID, title: base.pages[0]!.title, summary: base.pages[0]!.summary, slug: base.pages[0]!.slug, template: 'landing', blocks: base.pages[0]!.blocks }, overrideAccess: true })
    const settings = await payload.create({ collection: 'site-settings', data: { siteName: 'Reviewed Settings Studio', homepageId: pageID, defaultLocale: 'en-CA', organizationType: 'professional-service', seoDescription: 'A reviewed synthetic description.', searchEnabled: true }, draft: true, user: owner, overrideAccess: false })
    await expect(payload.update({ collection: 'site-settings', id: settings.id, data: { siteName: 'Denied' }, user: editor, overrideAccess: false })).rejects.toThrow()
    await expect(payload.update({ collection: 'site-settings', id: settings.id, data: { contractVersion: '9.9.9' }, user: owner, overrideAccess: false })).rejects.toThrow(/not editable/)
    const sets = await payload.find({ collection: 'change-sets', where: { actor: { equals: owner.id } }, overrideAccess: true, depth: 0 })
    const change = (sets.docs[0]!.changes as Array<{ collection: string; id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; beforeHash: string | null; afterHash: string | null }>).find((item) => item.collection === 'site-settings')!
    const candidate = buildCandidate(base, [change] as never, [`site-settings:${change.id}`], { themeVersion: '1.0.0', engineVersion: '1.0.0', contractVersion: '1.0.0' })
    expect(candidate.settings).toMatchObject({ siteName: 'Reviewed Settings Studio', homepageId: pageID, defaultLocale: 'en-CA', organizationType: 'professional-service', seoDescription: 'A reviewed synthetic description.', searchEnabled: true })
    expect(base.settings.siteName).toBe('Sample Studio')
  })
})
