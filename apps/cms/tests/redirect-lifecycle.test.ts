import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { getPayload } from 'payload'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { archivePage, archiveReferences, normalizeRedirectPath, recordRedirectHit, redirectForPublishedChange, validateRedirectSet } from '../src/redirect-lifecycle'
import { buildCandidate, canonicalHash } from '../src/publishing'
import { withPayloadTransaction } from '../src/auth-transaction'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'
import { snapshot } from '../src/editorial'

const versions = { themeVersion: '1.2.3', engineVersion: '1.2.3', contractVersion: '1.0.0' }
const directory = mkdtempSync(join(tmpdir(), 'site-engine-redirect-lifecycle-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'synthetic-redirect-lifecycle-secret-that-is-long-enough'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
const { default: config } = await import('../payload.config.js')
const archiveRoute = await import('../app/api/editorial/[action]/route.js')
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

  it('persists trusted redirect hits and leaves unknown paths unchanged', async () => {
    const redirect = await payload.create({ collection: 'redirects', data: { from: '/tracked', to: '/', status: 301 }, overrideAccess: true })
    const first = new Date('2026-10-05T12:00:00.000Z')
    const second = new Date('2026-10-05T12:01:00.000Z')

    await withPayloadTransaction(payload, (req) => recordRedirectHit(payload, req, ' /tracked/ ', first))
    await withPayloadTransaction(payload, (req) => recordRedirectHit(payload, req, '/tracked', second))
    await withPayloadTransaction(payload, (req) => recordRedirectHit(payload, req, '/not-configured', second))

    expect(await payload.findByID({ collection: 'redirects', id: redirect.id, depth: 0, overrideAccess: true })).toMatchObject({
      hitCount: 2,
      lastHitAt: second.toISOString(),
    })
    expect((await payload.find({ collection: 'redirects', where: { from: { equals: '/not-configured' } }, limit: 0, overrideAccess: true })).totalDocs).toBe(0)
  })

  it('records the immutable creator without exposing it to the public redirect snapshot', async () => {
    const suffix = randomUUID().slice(0, 8)
    const creator = await payload.create({ collection: 'users', data: { email: `redirect-creator-${suffix}@example.test`, name: 'Redirect creator', roles: ['editor'] }, overrideAccess: true })
    const editor = await payload.create({ collection: 'users', data: { email: `redirect-editor-${suffix}@example.test`, name: 'Later editor', roles: ['editor'] }, overrideAccess: true })
    const redirect = await withPayloadTransaction(payload, async req => {
      req.user = creator
      return payload.create({
        collection: 'redirects', data: { from: `/creator-${suffix}`, to: '/', status: 301, createdBy: editor.id, createdByLabel: 'Forged creator' },
        user: creator, overrideAccess: false, req, context: { editorialInternal: true },
      })
    })
    expect(typeof redirect.createdBy === 'string' ? redirect.createdBy : redirect.createdBy?.id).toBe(creator.id)
    expect(redirect.createdByLabel).toBe('Redirect creator')
    expect(snapshot('redirects', redirect as never)).toEqual({ from: `/creator-${suffix}`, to: '/', status: 301 })

    const updated = await withPayloadTransaction(payload, async req => {
      req.user = editor
      return payload.update({
        collection: 'redirects', id: redirect.id, data: { to: `/destination-${suffix}`, createdBy: editor.id, createdByLabel: 'Forged replacement' },
        user: editor, overrideAccess: false, req, context: { editorialInternal: true },
      })
    })
    expect(typeof updated.createdBy === 'string' ? updated.createdBy : updated.createdBy?.id).toBe(creator.id)
    expect(updated.createdByLabel).toBe('Redirect creator')
    await payload.delete({ collection: 'users', id: creator.id, overrideAccess: true })
    expect(await payload.findByID({ collection: 'redirects', id: redirect.id, depth: 0, overrideAccess: true })).toMatchObject({ createdBy: null, createdByLabel: 'Redirect creator' })

    const imported = await withPayloadTransaction(payload, async req => {
      req.user = editor
      return payload.create({ collection: 'redirects', data: { from: `/legacy-${suffix}`, to: '/', status: 301 }, overrideAccess: true, req, context: { editorialInternal: true, reviewedSnapshotImport: true } })
    })
    expect(imported).toMatchObject({ createdBy: null, createdByLabel: null })
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

  it('archives an ordinary page from a buildCandidate baseline while retaining explicit navigation protection', async () => {
    const base = structuredClone(neutralFixture)
    const section = base.settings.sections[0]!
    section.allowedTemplates.push('standard')
    const id = randomUUID()
    const target = { ...structuredClone(base.pages[0]!), id, sectionId: section.id, parentId: base.pages[0]!.id, title: 'Target', summary: 'A synthetic archive target with an adequate descriptive summary.', slug: `target-${id.slice(0, 8)}`, template: 'standard' as const, blocks: [] }
    base.pages.push(target)
    const candidateBaseline = buildCandidate(base, [], [], versions)
    expect(candidateBaseline.settings.sections[0]!.pageIds).not.toContain(id)
    const editor = await payload.create({ collection: 'users', data: { email: `${id}@example.test`, name: 'Editor', roles: ['editor'] }, overrideAccess: true })
    await payload.create({ collection: 'sections', data: { id: section.id, name: section.name, summary: section.summary ?? 'A synthetic section used for archive safety integration testing.', slug: section.slug, allowedTemplates: section.allowedTemplates, pageIds: [] }, overrideAccess: true })
    await payload.create({ collection: 'pages', data: { id: base.pages[0]!.id, sectionId: section.id, title: base.pages[0]!.title, summary: base.pages[0]!.summary, slug: base.pages[0]!.slug, template: 'landing', blocks: base.pages[0]!.blocks }, overrideAccess: true })
    const targetDraft = { ...target, status: undefined }
    delete (targetDraft as { status?: unknown }).status
    await payload.create({ collection: 'pages', data: targetDraft, overrideAccess: true })
    const child = await payload.create({ collection: 'pages', data: { sectionId: section.id, title: 'Reference', summary: 'A synthetic page which retains a parent reference for this safety test.', slug: `reference-${id.slice(0, 8)}`, parentId: id, template: 'standard', blocks: [] }, overrideAccess: true })
    await expect(withPayloadTransaction(payload, async req => { req.user = editor; return archivePage({ payload, req, pageID: id, baseline: candidateBaseline }) })).rejects.toThrow(`pages:${child.id}:parentId`)
    await payload.update({ collection: 'pages', id: child.id, data: { parentId: base.pages[0]!.id }, draft: true, overrideAccess: true })
    await withPayloadTransaction(payload, async req => { req.user = editor; await archivePage({ payload, req, pageID: id, baseline: candidateBaseline }) })
    expect((await payload.findByID({ collection: 'pages', id, draft: true, overrideAccess: true })).status).toBe('archived')
    expect((await payload.find({ collection: 'redirects', overrideAccess: true })).docs).toEqual(expect.arrayContaining([expect.objectContaining({ to: '/' })]))
  })

  it('archives an ordinary page through the HTTP lifecycle after its buildCandidate baseline is published', async () => {
    const base = structuredClone(neutralFixture)
    const section = base.settings.sections[0]!
    section.allowedTemplates.push('standard')
    const parent = base.pages[0]!
    const suffix = randomUUID().slice(0, 8)
    section.id = randomUUID(); section.slug = `archive-http-${suffix}`
    parent.id = randomUUID(); parent.sectionId = section.id; parent.slug = `parent-${suffix}`
    section.pageIds = [parent.id]; base.settings.homepageId = parent.id
    const targetID = randomUUID()
    const target = { ...structuredClone(parent), id: targetID, parentId: undefined, title: 'Archive by HTTP', summary: 'A synthetic published footer page that must remain archivable after its first release.', slug: `archive-http-${targetID.slice(0, 8)}`, template: 'standard' as const, blocks: [] }
    base.pages.push(target)
    const published = buildCandidate(base, [], [], versions)
    expect(published.settings.sections[0]!.pageIds).not.toContain(targetID)
    const editor = await payload.create({ collection: 'users', data: { email: `http-${targetID}@example.test`, name: 'HTTP editor', roles: ['editor'] }, overrideAccess: true })
    await payload.create({ collection: 'sections', data: { id: section.id, name: section.name, summary: section.summary ?? 'A synthetic section for archive HTTP lifecycle coverage.', slug: section.slug, allowedTemplates: section.allowedTemplates, pageIds: [] }, overrideAccess: true })
    for (const page of [...published.pages].sort((left, right) => Number(Boolean(left.parentId)) - Number(Boolean(right.parentId)))) await payload.create({ collection: 'pages', data: { ...page, status: undefined }, overrideAccess: true })
    const baselineSet = await payload.create({ collection: 'change-sets', data: { name: 'Published archive baseline', actor: editor.id, state: 'published', revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
    const legacyPublished = structuredClone(published); legacyPublished.settings.sections[0]!.pageIds.push(targetID)
    // The public footer derives this column from the section's page list. The
    // same list is the protected editorial navigation reference below.
    legacyPublished.settings.contractVersion = '1.6.0'
    legacyPublished.settings.navigation = { header: [], footer: { columns: [{ kind: 'section-pillars', heading: 'Footer services', sectionId: section.id }], bottomLinks: [] } }
    const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: canonicalHash(legacyPublished), changeSet: baselineSet.id, reviewRevision: 0, changeHash: 'baseline', manifest: legacyPublished, ...versions, approvedBy: editor.id, baselineSequence: 0 }, overrideAccess: true, context: { editorialInternal: true } })
    const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: `archive-http:${snapshot.id}`, sequence: 1, snapshot: snapshot.id, changeSet: baselineSet.id, reviewRevision: 0, changeHash: 'baseline', includedChangeKeys: [], status: 'completed', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
    await payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence: 1, snapshot: snapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { status: 'healthy' }, artifact: { digest: 'a'.repeat(64), sourceContentHash: snapshot.contentHash, ...versions, checks: [{ name: 'artifact-integrity', status: 'passed' }, { name: 'public-health', status: 'passed' }] } }, overrideAccess: true, context: { editorialInternal: true } })
    const token = newOpaqueToken(); const now = new Date().toISOString()
    await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: editor.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
    const selected = await payload.create({ collection: 'change-sets', data: { name: 'Archive selected set', actor: editor.id, state: 'open', revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
    const untouched = await payload.create({ collection: 'change-sets', data: { name: 'Archive untouched set', actor: editor.id, state: 'open', revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
    const request = (action: string, body: object) => archiveRoute.POST(new Request(`http://cms.test/api/editorial/${action}`, { method: 'POST', headers: { origin: 'http://cms.test', 'content-type': 'application/json', cookie: `${cookieName(SESSION_COOKIE)}=${token}`, 'x-site-engine-change-set': selected.id }, body: JSON.stringify(body) }), { params: Promise.resolve({ action }) })
    const rejected = await request('archive', { id: targetID, target: '/' })
    expect(rejected.status).toBe(400)
    expect((await rejected.json()).error).toContain(`navigation:${section.id}:pageIds.1`)
    expect((await payload.findByID({ collection: 'pages', id: targetID, draft: true, overrideAccess: true })).status).toBe('draft')
    expect((await payload.findByID({ collection: 'change-sets', id: selected.id, overrideAccess: true })).changes).toEqual([])
    expect((await payload.find({ collection: 'redirects', where: { from: { equals: `/${section.slug}/${target.slug}` } }, overrideAccess: true })).totalDocs).toBe(0)
    const response = await request('archive', { id: targetID, target: '/', removeNavigationReference: true })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ redirect: { to: '/' } })
    const archiveSet = await payload.findByID({ collection: 'change-sets', id: selected.id, overrideAccess: true })
    expect((await payload.findByID({ collection: 'change-sets', id: untouched.id, overrideAccess: true })).changes).toEqual([])
    expect(archiveSet.changes).toEqual(expect.arrayContaining([expect.objectContaining({ collection: 'pages', id: targetID }), expect.objectContaining({ collection: 'redirects' }), expect.objectContaining({ collection: 'sections', id: section.id, after: expect.objectContaining({ pageIds: [parent.id] }) })]))
    const candidate = buildCandidate(legacyPublished, archiveSet.changes as never[], (archiveSet.changes as Array<{ collection: string; id: string }>).map(change => `${change.collection}:${change.id}`), versions)
    expect(candidate.settings.sections[0]!.pageIds).toEqual([parent.id])
    expect(candidate.pages.find(page => page.id === targetID)?.status).toBe('archived')
    expect((await request('submit', { id: selected.id })).status).toBe(200)
    expect((await payload.findByID({ collection: 'change-sets', id: selected.id, overrideAccess: true })).state).toBe('submitted')
  })

  it('archives imported replacement-home starter records in one named SQLite set without a root redirect', async () => {
    const baseline = structuredClone(neutralFixture)
    const section = baseline.settings.sections[0]!
    section.allowedTemplates.push('standard')
    const suffix = randomUUID().slice(0, 8)
    section.id = randomUUID(); section.slug = `retire-${suffix}`
    const oldHome = baseline.pages[0]!
    oldHome.id = randomUUID(); oldHome.sectionId = section.id; oldHome.slug = `starter-${suffix}`
    baseline.settings.homepageId = oldHome.id
    const child = { ...structuredClone(oldHome), id: randomUUID(), parentId: oldHome.id, title: 'Starter child', summary: 'A temporary child is archived before its temporary parent.', slug: `child-${suffix}`, template: 'standard' as const, blocks: [] }
    const retiringRoot = { ...structuredClone(oldHome), id: randomUUID(), title: 'Starter guide', summary: 'A temporary root page proves its explicit redirect is captured before the next archive.', slug: `guide-${suffix}`, template: 'standard' as const, blocks: [] }
    const authored = { ...structuredClone(oldHome), id: randomUUID(), title: 'Authored page', summary: 'An authored page remains outside the explicit starter retirement set.', slug: `authored-${suffix}`, template: 'standard' as const, blocks: [] }
    const replacement = { ...structuredClone(oldHome), id: randomUUID(), title: 'Client homepage', summary: 'A reviewed client homepage replaces the original starter root.', slug: `client-home-${suffix}`, template: 'landing' as const }
    baseline.pages.push(child, retiringRoot, authored)
    section.pageIds = [oldHome.id, child.id, retiringRoot.id, authored.id]
    const editor = await payload.create({ collection: 'users', data: { email: `retire-${suffix}@example.test`, name: 'Retirement editor', roles: ['editor'] }, overrideAccess: true })
    await payload.create({ collection: 'sections', data: { id: section.id, name: section.name, summary: section.summary ?? 'A section for atomic starter retirement coverage.', slug: section.slug, allowedTemplates: section.allowedTemplates, pageIds: [] }, overrideAccess: true })
    for (const page of [oldHome, child, retiringRoot, authored, replacement]) {
      // A landing page cannot be persisted empty. The importer materializes
      // this temporary starter as a standard page; the coalesced archive still
      // retains the frozen landing before-image in the reviewed change.
      const data = page.id === oldHome.id ? { ...page, template: 'standard' as const, blocks: [], status: undefined } : { ...page, status: undefined }
      await payload.create({ collection: 'pages', data, overrideAccess: true })
    }
    await payload.update({ collection: 'sections', id: section.id, data: { pageIds: section.pageIds }, overrideAccess: true })
    const oldBefore = snapshot('pages', oldHome as never)!
    const stagedOld = { ...oldBefore, template: 'standard', blocks: [] }
    const retiringBefore = snapshot('pages', retiringRoot as never)!
    const stagedReplacement = snapshot('pages', replacement as never)!
    const sectionBefore = snapshot('sections', section as never)!
    const stagedSection = { ...sectionBefore, pageIds: [replacement.id, authored.id] }
    const settingsBefore = snapshot('site-settings', baseline.settings as never)!
    const stagedSettings = { ...settingsBefore, homepageId: replacement.id }
    const set = await payload.create({ collection: 'change-sets', data: {
      name: 'Imported starter retirement', actor: editor.id, state: 'open', revision: 5,
      changes: [
        { collection: 'pages', id: oldHome.id, before: oldBefore, after: stagedOld, beforeHash: canonicalHash(oldBefore), afterHash: canonicalHash(stagedOld) },
        { collection: 'pages', id: retiringRoot.id, before: retiringBefore, after: retiringBefore, beforeHash: canonicalHash(retiringBefore), afterHash: canonicalHash(retiringBefore) },
        { collection: 'pages', id: replacement.id, before: null, after: stagedReplacement, beforeHash: null, afterHash: canonicalHash(stagedReplacement) },
        { collection: 'sections', id: section.id, before: sectionBefore, after: stagedSection, beforeHash: canonicalHash(sectionBefore), afterHash: canonicalHash(stagedSection) },
        { collection: 'site-settings', id: 'site-settings:active', before: settingsBefore, after: stagedSettings, beforeHash: canonicalHash(settingsBefore), afterHash: canonicalHash(stagedSettings) },
      ],
    }, overrideAccess: true, context: { editorialInternal: true } })

    await withPayloadTransaction(payload, async req => {
      req.user = editor; req.headers.set('x-site-engine-change-set', set.id)
      await archivePage({ payload, req, pageID: retiringRoot.id, target: '/', baseline })
    })
    await expect(withPayloadTransaction(payload, async req => {
      req.user = editor; req.headers.set('x-site-engine-change-set', set.id)
      return archivePage({ payload, req, pageID: oldHome.id, baseline })
    })).rejects.toThrow(`pages:${child.id}:parentId`)
    await withPayloadTransaction(payload, async req => {
      req.user = editor; req.headers.set('x-site-engine-change-set', set.id)
      await archivePage({ payload, req, pageID: child.id, target: '/', baseline })
    })
    const retiredHome = await withPayloadTransaction(payload, async req => {
      req.user = editor; req.headers.set('x-site-engine-change-set', set.id)
      return archivePage({ payload, req, pageID: oldHome.id, baseline })
    })
    expect(retiredHome.redirect).toBeUndefined()
    const captured = await payload.findByID({ collection: 'change-sets', id: set.id, overrideAccess: true })
    const changes = captured.changes as Array<{ collection: string; id: string; before: unknown; after: unknown }>
    expect(changes).toEqual(expect.arrayContaining([expect.objectContaining({ collection: 'redirects', after: expect.objectContaining({ from: `/retire-${suffix}/guide-${suffix}`, to: '/' }) })]))
    expect(changes.find(change => change.collection === 'pages' && change.id === oldHome.id)).toMatchObject({ before: oldBefore, after: expect.objectContaining({ status: 'archived' }) })
    const candidate = buildCandidate(baseline, changes as never[], changes.map(change => `${change.collection}:${change.id}`), versions)
    expect(candidate.settings.homepageId).toBe(replacement.id)
    expect(candidate.pages.find(page => page.id === replacement.id)?.status).toBe('published')
    expect(candidate.pages.find(page => page.id === oldHome.id)?.status).toBe('archived')
    expect(candidate.pages.find(page => page.id === child.id)?.status).toBe('archived')
    expect(candidate.pages.find(page => page.id === authored.id)?.status).toBe('published')
    expect(candidate.redirects.some(redirect => redirect.from === '/')).toBe(false)
  })

  it('denies homepage and landing navigation removal without creating a draft or change set', async () => {
    for (const protectedField of ['homepageId', 'landingPageId'] as const) {
      const baseline = structuredClone(neutralFixture); const id = randomUUID(); const section = baseline.settings.sections[0]!; const page = baseline.pages[0]!
      section.id = randomUUID(); section.slug = `protected-${id.slice(0, 8)}`; section.pageIds = [id]; page.id = id; page.sectionId = section.id; page.slug = `protected-page-${id.slice(0, 8)}`
      baseline.settings.homepageId = protectedField === 'homepageId' ? id : undefined
      section.landingPageId = protectedField === 'landingPageId' ? id : undefined
      const editor = await payload.create({ collection: 'users', data: { email: `${protectedField}-${id}@example.test`, name: 'Protected editor', roles: ['editor'] }, overrideAccess: true })
      await payload.create({ collection: 'sections', data: { id: section.id, name: section.name, summary: section.summary ?? 'A synthetic protected navigation section for archive denial coverage.', slug: section.slug, allowedTemplates: section.allowedTemplates, pageIds: [] }, overrideAccess: true })
      await payload.create({ collection: 'pages', data: { ...page, status: undefined }, overrideAccess: true })
      await expect(withPayloadTransaction(payload, req => { req.user = editor; return archivePage({ payload, req, pageID: id, baseline, removeNavigationReference: true }) })).rejects.toThrow(/Homepage and section landing/)
      expect((await payload.findByID({ collection: 'pages', id, draft: true, overrideAccess: true })).status).toBe('draft')
      expect((await payload.find({ collection: 'change-sets', where: { actor: { equals: editor.id } }, overrideAccess: true })).totalDocs).toBe(0)
    }
  })

  it('rolls back an invalid archive redirect before changing the page, section, or selected set', async () => {
    const baseline = structuredClone(neutralFixture); const id = randomUUID(); const section = baseline.settings.sections[0]!; const page = baseline.pages[0]!
    section.id = randomUUID(); section.slug = `invalid-target-${id.slice(0, 8)}`; section.allowedTemplates.push('standard'); section.pageIds = []
    page.id = randomUUID(); page.sectionId = section.id; page.slug = `invalid-home-${id.slice(0, 8)}`; baseline.settings.homepageId = page.id
    const target = { ...structuredClone(page), id, sectionId: section.id, slug: `invalid-target-page-${id.slice(0, 8)}`, template: 'standard' as const, blocks: [] }
    baseline.pages.push(target)
    const editor = await payload.create({ collection: 'users', data: { email: `invalid-${id}@example.test`, name: 'Invalid target editor', roles: ['editor'] }, overrideAccess: true })
    await payload.create({ collection: 'sections', data: { id: section.id, name: section.name, summary: section.summary ?? 'A synthetic section for invalid archive target rollback coverage.', slug: section.slug, allowedTemplates: section.allowedTemplates, pageIds: [] }, overrideAccess: true })
    await payload.create({ collection: 'pages', data: { ...page, status: undefined }, overrideAccess: true })
    await payload.create({ collection: 'pages', data: { ...target, status: undefined }, overrideAccess: true })
    const selected = await payload.create({ collection: 'change-sets', data: { name: 'Invalid archive selected', actor: editor.id, state: 'open', revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
    await expect(withPayloadTransaction(payload, req => { req.user = editor; req.headers.set('x-site-engine-change-set', selected.id); return archivePage({ payload, req, pageID: id, target: 'https://outside.example', baseline }) })).rejects.toThrow('Invalid redirect path')
    expect((await payload.findByID({ collection: 'pages', id, draft: true, overrideAccess: true })).status).toBe('draft')
    expect((await payload.findByID({ collection: 'sections', id: section.id, draft: true, overrideAccess: true })).pageIds).toEqual([])
    expect(await payload.findByID({ collection: 'change-sets', id: selected.id, overrideAccess: true })).toMatchObject({ revision: 0, changes: [] })
  })
})
