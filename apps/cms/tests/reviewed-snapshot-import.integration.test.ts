import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { withPayloadTransaction } from '../src/auth-transaction'
import { importReviewedSnapshot } from '../src/reviewed-snapshot-import'
import { buildCandidate, canonicalHash } from '../src/publishing'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-reviewed-import-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-reviewed-import'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
const { default: config } = await import('../payload.config.js')
const importRoute = await import('../app/api/editorial/import-snapshot/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

async function sessionFor(userID: string): Promise<string> {
  const token = newOpaqueToken(); const now = new Date().toISOString()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: userID, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  return token
}

async function publishBaseline(actorID: string, manifest = neutralFixture): Promise<void> {
  const set = await payload.create({ collection: 'change-sets', data: { name: `Baseline ${randomUUID()}`, actor: actorID, state: 'published', revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
  const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: canonicalHash(manifest), changeSet: set.id, reviewRevision: 0, changeHash: 'baseline', manifest, themeVersion: '1.0.0', engineVersion: 'test', contractVersion: '1.0.0', approvedBy: actorID, baselineSequence: 0 }, overrideAccess: true, context: { editorialInternal: true } })
  const sequence = (await payload.find({ collection: 'published-releases', limit: 0, overrideAccess: true })).totalDocs + 1
  const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: `baseline:${randomUUID()}`, sequence, snapshot: snapshot.id, changeSet: set.id, reviewRevision: 0, changeHash: 'baseline', includedChangeKeys: [], status: 'completed', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence, snapshot: snapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { status: 'healthy' }, artifact: { digest: 'a'.repeat(64), sourceContentHash: snapshot.contentHash, themeVersion: '1.0.0', engineVersion: 'test', contractVersion: '1.0.0', checks: [] } }, overrideAccess: true, context: { editorialInternal: true } })
}

function isolatedFixture() {
  const fixture = structuredClone(neutralFixture); const sectionID = randomUUID(); const pageID = randomUUID(); const suffix = sectionID.slice(0, 8)
  fixture.settings.sections[0]!.id = sectionID; fixture.settings.sections[0]!.slug = `general-${suffix}`; fixture.settings.sections[0]!.pageIds = [pageID]
  fixture.pages[0]!.id = pageID; fixture.pages[0]!.sectionId = sectionID; fixture.pages[0]!.slug = `welcome-${suffix}`; fixture.settings.homepageId = pageID
  return fixture
}

describe('reviewed snapshot reconciliation', () => {
  it('uses published before-images when CMS drafts are empty and leaves the baseline immutable', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `owner-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
    const baseline = isolatedFixture(); const desired = structuredClone(baseline)
    desired.settings.siteName = 'Imported generic studio'; desired.settings.defaultLocale = 'en-CA'; desired.settings.searchEnabled = true
    const section = desired.settings.sections[0]!; section.summary = 'A generic section imported through ordinary editorial review.'
    const page = desired.pages[0]!; page.summary = 'A generic landing page imported through ordinary editorial review with a longer summary.'
    const set = await withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Reconcile generic seed', manifest: desired, baseline }) })
    expect(set.state).toBe('open')
    const persisted = await payload.findByID({ collection: 'change-sets', id: String(set.id), overrideAccess: true })
    const changes = persisted.changes as Array<{ collection: string; id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>
    expect(changes).toEqual(expect.arrayContaining([expect.objectContaining({ collection: 'pages', id: page.id, before: expect.objectContaining({ title: baseline.pages[0]!.title }) }), expect.objectContaining({ collection: 'site-settings', before: expect.objectContaining({ siteName: baseline.settings.siteName }) })]))
    const candidate = buildCandidate(baseline, changes as never, changes.map(change => `${change.collection}:${change.id}`), { themeVersion: '1.0.0', engineVersion: 'test', contractVersion: '1.0.0' })
    expect(candidate.settings.siteName).toBe('Imported generic studio')
    expect(candidate.settings.searchEnabled).toBe(true)
    expect(baseline.settings.siteName).toBe('Sample Studio')
    expect((await payload.find({ collection: 'audit-events', where: { event: { equals: 'editorial.snapshot_imported' } }, overrideAccess: true })).totalDocs).toBe(1)
    await payload.update({ collection: 'change-sets', id: String(set.id), data: { state: 'discarded' }, overrideAccess: true, context: { editorialInternal: true } })
  })

  it('preserves an explicit false search setting through reviewed import', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `search-false-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
    const baseline = isolatedFixture(); baseline.settings.searchEnabled = true
    const desired = structuredClone(baseline); desired.settings.searchEnabled = false
    const set = await withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Disable reviewed search', manifest: desired, baseline }) })
    const changes = (await payload.findByID({ collection: 'change-sets', id: String(set.id), overrideAccess: true })).changes as Array<{ collection: string; id: string; after: Record<string, unknown> | null }>
    expect(changes).toEqual(expect.arrayContaining([expect.objectContaining({ collection: 'site-settings', after: expect.objectContaining({ searchEnabled: false }) })]))
    const candidate = buildCandidate(baseline, changes as never, changes.map(change => `${change.collection}:${change.id}`), { themeVersion: '1.0.0', engineVersion: 'test', contractVersion: '1.0.0' })
    expect(candidate.settings.searchEnabled).toBe(false)
    await payload.update({ collection: 'change-sets', id: String(set.id), data: { state: 'discarded' }, overrideAccess: true, context: { editorialInternal: true } })
  })

  it('rejects an Editor and rolls back draft writes when a valid manifest collides with persisted content', async () => {
    const editor = await payload.create({ collection: 'users', data: { email: `editor-${randomUUID()}@example.test`, name: 'Editor', roles: ['editor'] }, overrideAccess: true })
    await expect(withPayloadTransaction(payload, req => { req.user = editor as never; return importReviewedSnapshot({ payload, req, actor: editor, name: 'Denied', manifest: neutralFixture, baseline: neutralFixture }) })).rejects.toThrow('Owner role required')
    const owner = await payload.create({ collection: 'users', data: { email: `invalid-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
    const baseline = isolatedFixture(); baseline.settings.sections[0]!.summary = 'The persisted section summary must survive the failed transaction.'; baseline.settings.sections[0]!.allowedTemplates.push('standard'); const invalid = structuredClone(baseline)
    invalid.settings.sections[0]!.summary = 'This change is written before the later section hits a persisted uniqueness constraint.'
    const collisionID = randomUUID(); const collisionSlug = `occupied-${collisionID.slice(0, 8)}`
    invalid.settings.sections[0]!.pageIds.push(collisionID)
    invalid.pages.push({ ...structuredClone(invalid.pages[0]!), id: collisionID, title: 'Collision page', summary: 'This valid imported page collides with an existing draft only after earlier writes.', slug: collisionSlug, template: 'standard', blocks: [] })
    await payload.create({ collection: 'sections', data: { ...baseline.settings.sections[0]!, pageIds: [] }, draft: true, overrideAccess: true })
    await payload.create({ collection: 'pages', data: { id: randomUUID(), sectionId: baseline.settings.sections[0]!.id, title: 'Persisted collision', summary: 'This existing page causes the later imported page insert to fail inside the transaction.', slug: collisionSlug, template: 'standard', blocks: [] }, overrideAccess: true })
    await expect(withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Invalid', manifest: invalid, baseline }) })).rejects.toThrow()
    expect((await payload.find({ collection: 'change-sets', where: { actor: { equals: owner.id } }, overrideAccess: true })).totalDocs).toBe(0)
    expect((await payload.findByID({ collection: 'sections', id: baseline.settings.sections[0]!.id, draft: true, overrideAccess: true })).summary).toBe(baseline.settings.sections[0]!.summary)
  })

  it('creates parents before children even when the reviewed manifest lists children first', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `ordering-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
    const baseline = isolatedFixture(); const desired = structuredClone(baseline); const section = desired.settings.sections[0]!; const parentID = randomUUID(); const childID = randomUUID()
    section.allowedTemplates.push('standard'); section.pageIds.push(parentID, childID)
    const source = desired.pages[0]!
    const parent = { ...structuredClone(source), id: parentID, title: 'Imported parent', summary: 'A parent page that must exist before its child can be reconciled.', slug: `parent-${parentID.slice(0, 8)}`, template: 'standard' as const, blocks: [] }
    const child = { ...structuredClone(parent), id: childID, parentId: parentID, title: 'Imported child', summary: 'A child page deliberately listed before its parent in the imported manifest.', slug: `child-${childID.slice(0, 8)}` }
    desired.pages.push(child, parent)
    const set = await withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Parent order', manifest: desired, baseline }) })
    expect((await payload.findByID({ collection: 'pages', id: childID, draft: true, overrideAccess: true })).parentId).toMatchObject({ id: parentID })
    await payload.update({ collection: 'change-sets', id: String(set.id), data: { state: 'discarded' }, overrideAccess: true, context: { editorialInternal: true } })
  })

  it('protects pending draft keys before it writes imported drafts', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `pending-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true }); const baseline = isolatedFixture()
    const blocked = await payload.create({ collection: 'change-sets', data: { name: 'Pending section', actor: owner.id, state: 'open', revision: 0, changes: [{ collection: 'sections', id: baseline.settings.sections[0]!.id }] }, overrideAccess: true, context: { editorialInternal: true } })
    expect(blocked.changes).toEqual([{ collection: 'sections', id: baseline.settings.sections[0]!.id }])
    await expect(withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Blocked', manifest: baseline, baseline }) })).rejects.toThrow('pending editorial change')
    await expect(payload.findByID({ collection: 'sections', id: baseline.settings.sections[0]!.id, draft: true, overrideAccess: true })).rejects.toThrow()
    await payload.update({ collection: 'change-sets', id: blocked.id, data: { state: 'discarded' }, overrideAccess: true, context: { editorialInternal: true } })
  })

  it('protects a pending site-settings capture by its persisted singleton ID', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `pending-settings-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
    let settings = (await payload.find({ collection: 'site-settings', limit: 1, depth: 0, draft: true, overrideAccess: true })).docs[0]
    if (!settings) settings = await payload.create({ collection: 'site-settings', data: { siteName: 'Pending settings baseline', defaultLocale: 'en' }, draft: true, overrideAccess: true })
    const before = settings.siteName
    const blocked = await payload.create({ collection: 'change-sets', data: { name: 'Pending singleton', actor: owner.id, state: 'open', revision: 0, changes: [{ collection: 'site-settings', id: settings.id }] }, overrideAccess: true, context: { editorialInternal: true } })
    const baseline = isolatedFixture(); const desired = structuredClone(baseline); desired.settings.siteName = 'This import must not overwrite a pending singleton draft.'
    await expect(withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Blocked singleton', manifest: desired, baseline }) })).rejects.toThrow('pending editorial change')
    expect((await payload.findByID({ collection: 'site-settings', id: settings.id, draft: true, overrideAccess: true })).siteName).toBe(before)
    await payload.update({ collection: 'change-sets', id: blocked.id, data: { state: 'discarded' }, overrideAccess: true, context: { editorialInternal: true } })
  })

  it('protects a pending redirect capture by the existing redirect ID', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `pending-redirect-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
    const from = `/pending-${randomUUID().slice(0, 8)}`
    const redirect = await payload.create({ collection: 'redirects', data: { from, to: '/', status: 301 }, draft: true, overrideAccess: true })
    const blocked = await payload.create({ collection: 'change-sets', data: { name: 'Pending redirect', actor: owner.id, state: 'open', revision: 0, changes: [{ collection: 'redirects', id: redirect.id }] }, overrideAccess: true, context: { editorialInternal: true } })
    const baseline = isolatedFixture(); baseline.redirects.push({ from, to: '/', status: 301 })
    const desired = structuredClone(baseline); desired.redirects[0]!.to = '/updated-target'
    await expect(withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Blocked redirect', manifest: desired, baseline }) })).rejects.toThrow('pending editorial change')
    expect((await payload.findByID({ collection: 'redirects', id: redirect.id, draft: true, overrideAccess: true })).to).toBe('/')
    await payload.update({ collection: 'change-sets', id: blocked.id, data: { state: 'discarded' }, overrideAccess: true, context: { editorialInternal: true } })
  })

  it('enforces same-origin, authentication, and owner-only HTTP snapshot imports', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `http-owner-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
    const editor = await payload.create({ collection: 'users', data: { email: `http-editor-${randomUUID()}@example.test`, name: 'Editor', roles: ['editor'] }, overrideAccess: true })
    const baseline = isolatedFixture(); await publishBaseline(owner.id, baseline)
    const request = (token?: string, origin = 'http://cms.test') => importRoute.POST(new Request('http://cms.test/api/editorial/import-snapshot', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(token ? { cookie: `${cookieName(SESSION_COOKIE)}=${token}` } : {}) }, body: JSON.stringify({ name: 'HTTP import', manifest: baseline }) }))
    expect((await request(await sessionFor(owner.id), 'http://attacker.test')).status).toBe(403)
    expect((await request()).status).toBe(401)
    expect((await request(await sessionFor(editor.id))).status).toBe(403)
    const response = await request(await sessionFor(owner.id)); const responseBody = await response.text(); expect(response.status, responseBody).toBe(200)
    expect(JSON.parse(responseBody)).toMatchObject({ state: 'open', name: 'HTTP import' })
  })
})
