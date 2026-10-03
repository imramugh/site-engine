import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { getPayload } from 'payload'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { archivePage, archiveReferences, normalizeRedirectPath, redirectForPublishedChange, validateRedirectSet } from '../src/redirect-lifecycle'
import { buildCandidate, canonicalHash } from '../src/publishing'
import { withPayloadTransaction } from '../src/auth-transaction'

const versions = { themeVersion: '1.2.3', engineVersion: '1.2.3', contractVersion: '1.0.0' }
const directory = mkdtempSync(join(tmpdir(), 'site-engine-redirect-lifecycle-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'synthetic-redirect-lifecycle-secret-that-is-long-enough'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

describe('ENG-013 redirect and archive lifecycle', () => {
  it('canonicalizes paths and rejects duplicate, loop, and chain redirect rules', () => {
    expect(normalizeRedirectPath(' /legacy/ ')).toBe('/legacy')
    expect(() => normalizeRedirectPath('https://outside.example')).toThrow('Invalid redirect path')
    expect(() => validateRedirectSet([{ from: '/a', to: '/b' }, { from: '/b', to: '/a' }])).toThrow('another redirect')
    expect(() => validateRedirectSet([{ from: '/a', to: '/destination' }, { from: '/a/', to: '/other' }])).toThrow('not unique')
  })

  it('returns exact ID, href, homepage, and navigation reference locations before archive', () => {
    const snapshot = structuredClone(neutralFixture)
    const target = snapshot.pages[0]!
    snapshot.settings.sections[0]!.landingPageId = target.id
    const references = archiveReferences(target.id, [
      { id: 'child', parentId: target.id, blocks: [] },
      { id: 'related', blocks: [{ type: 'relatedServices', pageIds: [target.id] }] as never[] },
      { id: 'linked', blocks: [{ type: 'cta', cta: { href: '/' } }] as never[] },
    ], snapshot)
    expect(references).toEqual(expect.arrayContaining([
      { collection: 'pages', id: 'child', field: 'parentId' },
      { collection: 'pages', id: 'related', field: 'blocks.0.pageIds.0' },
      { collection: 'pages', id: 'linked', field: 'blocks.0.cta.href' },
      { collection: 'navigation', id: 'settings', field: 'homepageId' },
      { collection: 'navigation', id: snapshot.settings.sections[0]!.id, field: 'landingPageId' },
      { collection: 'navigation', id: snapshot.settings.sections[0]!.id, field: 'pageIds.0' },
    ]))
  })

  it('defaults an archive redirect to its published parent and blocks a root archive without a target', () => {
    const snapshot = structuredClone(neutralFixture)
    const section = snapshot.settings.sections[0]!
    section.allowedTemplates.push('standard')
    const parent = snapshot.pages[0]!
    parent.id = '11111111-1111-4111-8111-111111111111'; parent.sectionId = section.id; parent.slug = 'parent'
    snapshot.settings.homepageId = parent.id; section.pageIds = [parent.id, '22222222-2222-4222-8222-222222222222']
    snapshot.pages.push({ ...structuredClone(parent), id: '22222222-2222-4222-8222-222222222222', parentId: parent.id, title: 'Child', summary: 'A synthetic child page with a valid descriptive summary.', slug: 'child', template: 'standard', blocks: [] })
    expect(redirectForPublishedChange(snapshot, '22222222-2222-4222-8222-222222222222')).toEqual({ from: '/general/parent/child', to: '/', status: 301 })
    expect(() => redirectForPublishedChange(snapshot, parent.id)).toThrow('target is required')
  })

  it('adds a single permanent redirect when an approved page move or archive changes its public route', () => {
    const base = structuredClone(neutralFixture)
    const section = base.settings.sections[0]!
    section.allowedTemplates.push('standard')
    const page = { ...structuredClone(base.pages[0]!), id: '33333333-3333-4333-8333-333333333333', title: 'Old route', summary: 'A synthetic page that is moved during an approved change set.', slug: 'old-route', template: 'standard' as const, blocks: [] }
    base.pages.push(page); section.pageIds.push(page.id)
    const before = { title: page.title, slug: page.slug, sectionId: page.sectionId, summary: page.summary, template: page.template, status: 'published', blocks: page.blocks }
    const moved = buildCandidate(base, [{ collection: 'pages', id: page.id, before, after: { ...before, slug: 'moved' }, beforeHash: canonicalHash(before), afterHash: null }], [`pages:${page.id}`], versions)
    expect(moved.redirects).toEqual([{ from: '/general/old-route', to: '/general/moved', status: 301 }])
  })

  it('honours an explicit redirect for an archived root or child page before deriving a parent target', () => {
    const base = structuredClone(neutralFixture)
    const section = base.settings.sections[0]!
    section.allowedTemplates.push('standard')
    const root = { ...structuredClone(base.pages[0]!), id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Retired root page', summary: 'A synthetic root page with a redirect selected before archival.', slug: 'retired', template: 'standard' as const, blocks: [] }
    base.pages.push(root); section.pageIds.push(root.id)
    const rootBefore = { title: root.title, slug: root.slug, sectionId: root.sectionId, summary: root.summary, template: root.template, status: 'published', blocks: root.blocks }
    const rootCandidate = buildCandidate(base, [
      { collection: 'pages', id: root.id, before: rootBefore, after: { ...rootBefore, status: 'archived' }, beforeHash: canonicalHash(rootBefore), afterHash: null },
      { collection: 'redirects', id: '/general/retired', before: null, after: { from: '/general/retired', to: '/', status: 301 }, beforeHash: null, afterHash: null },
    ], [`pages:${root.id}`, 'redirects:/general/retired'], versions)
    expect(rootCandidate.redirects).toEqual([{ from: '/general/retired', to: '/', status: 301 }])

    const parent = { ...structuredClone(root), id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Archive parent page', slug: 'parent' }
    const destination = { ...structuredClone(root), id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'Selected destination page', slug: 'destination' }
    const child = { ...structuredClone(root), id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', title: 'Archived child page', slug: 'child', parentId: parent.id }
    base.pages.push(parent, destination, child); section.pageIds.push(parent.id, destination.id, child.id)
    const childBefore = { title: child.title, slug: child.slug, sectionId: child.sectionId, parentId: child.parentId, summary: child.summary, template: child.template, status: 'published', blocks: child.blocks }
    const childCandidate = buildCandidate(base, [
      { collection: 'pages', id: child.id, before: childBefore, after: { ...childBefore, status: 'archived' }, beforeHash: canonicalHash(childBefore), afterHash: null },
      { collection: 'redirects', id: '/general/parent/child', before: null, after: { from: '/general/parent/child', to: '/general/destination', status: 301 }, beforeHash: null, afterHash: null },
    ], [`pages:${child.id}`, 'redirects:/general/parent/child'], versions)
    expect(childCandidate.redirects).toEqual([{ from: '/general/parent/child', to: '/general/destination', status: 301 }])
  })

  it('accepts a pending change captured before page status was added to the snapshot hash', () => {
    const base = structuredClone(neutralFixture)
    const section = base.settings.sections[0]!
    section.allowedTemplates.push('standard')
    const page = { ...structuredClone(base.pages[0]!), id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', title: 'Legacy captured page', summary: 'A synthetic page whose pending change predates the status snapshot field.', slug: 'legacy-captured', template: 'standard' as const, blocks: [] }
    base.pages.push(page); section.pageIds.push(page.id)
    const legacyBefore = { title: page.title, slug: page.slug, sectionId: page.sectionId, summary: page.summary, template: page.template, blocks: page.blocks }
    const candidate = buildCandidate(base, [{ collection: 'pages', id: page.id, before: legacyBefore, after: { ...legacyBefore, slug: 'updated-legacy-captured' }, beforeHash: canonicalHash(legacyBefore), afterHash: null }], [`pages:${page.id}`], versions)
    expect(candidate.pages.find((item) => item.id === page.id)?.slug).toBe('updated-legacy-captured')
  })

  it('blocks referenced pages and archives an unreferenced published page with its parent redirect', async () => {
    const base = structuredClone(neutralFixture)
    const section = base.settings.sections[0]!
    section.allowedTemplates.push('standard')
    const id = randomUUID()
    const target = { ...structuredClone(base.pages[0]!), id, sectionId: section.id, parentId: base.pages[0]!.id, title: 'Target', summary: 'A synthetic archive target with an adequate descriptive summary.', slug: `target-${id.slice(0, 8)}`, template: 'standard' as const, blocks: [] }
    base.pages.push(target); section.pageIds.push(id)
    const editor = await payload.create({ collection: 'users', data: { email: `${id}@example.test`, name: 'Editor', roles: ['editor'] }, overrideAccess: true })
    await payload.create({ collection: 'sections', data: { id: section.id, name: section.name, summary: section.summary ?? 'A synthetic section used for archive safety integration testing.', slug: section.slug, allowedTemplates: section.allowedTemplates, pageIds: [] }, overrideAccess: true })
    await payload.create({ collection: 'pages', data: { id: base.pages[0]!.id, sectionId: section.id, title: base.pages[0]!.title, summary: base.pages[0]!.summary, slug: base.pages[0]!.slug, template: 'landing', blocks: base.pages[0]!.blocks }, overrideAccess: true })
    const targetDraft = { ...target, status: undefined }
    delete (targetDraft as { status?: unknown }).status
    await payload.create({ collection: 'pages', data: targetDraft, overrideAccess: true })
    const child = await payload.create({ collection: 'pages', data: { sectionId: section.id, title: 'Reference', summary: 'A synthetic page which retains a parent reference for this safety test.', slug: `reference-${id.slice(0, 8)}`, parentId: id, template: 'standard', blocks: [] }, overrideAccess: true })
    await expect(withPayloadTransaction(payload, async req => { req.user = editor; return archivePage({ payload, req, pageID: id, baseline: base }) })).rejects.toThrow(`pages:${child.id}:parentId`)
    await payload.update({ collection: 'pages', id: child.id, data: { parentId: base.pages[0]!.id }, draft: true, overrideAccess: true })
    base.settings.sections[0]!.pageIds = base.settings.sections[0]!.pageIds.filter((pageID) => pageID !== id)
    await withPayloadTransaction(payload, async req => { req.user = editor; await archivePage({ payload, req, pageID: id, baseline: base }) })
    expect((await payload.findByID({ collection: 'pages', id, draft: true, overrideAccess: true })).status).toBe('archived')
    expect((await payload.find({ collection: 'redirects', overrideAccess: true })).docs).toEqual(expect.arrayContaining([expect.objectContaining({ to: '/' })]))
  })
})
