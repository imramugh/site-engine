import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { withPayloadTransaction } from '../src/auth-transaction'
import { importReviewedSnapshot } from '../src/reviewed-snapshot-import'
import { buildCandidate, canonicalHash } from '../src/publishing'
import { transitionChangeSet } from '../src/editorial'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-reviewed-import-'))
const registryFile = join(directory, 'theme-registry.json')
const oldThemeManifest = { name: 'synthetic-import-theme', version: '1.4.0', contract: '1.4.0', entry: './dist/renderer.js', standardBlocks: ['hero', 'faq'], settingKeys: [], extensionBlocks: [], motion: { presets: [], intentFallbacks: {} } }
const newThemeManifest = { ...oldThemeManifest, version: '1.5.0', contract: '1.5.0' }
const navigationThemeManifest = { ...oldThemeManifest, version: '1.6.0', contract: '1.6.0' }
const themeRegistry = { themes: [{ manifest: oldThemeManifest, installedAt: '2026-10-04T00:00:00.000Z' }, { manifest: newThemeManifest, installedAt: '2026-10-05T00:00:00.000Z' }, { manifest: navigationThemeManifest, installedAt: '2026-10-06T00:00:00.000Z' }] }
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-reviewed-import'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
process.env.SITE_THEME_REGISTRY_JSON = registryFile
writeFileSync(registryFile, JSON.stringify(themeRegistry))
const { default: config } = await import('../payload.config.js')
const { getInstalledTheme, parseThemeRegistry } = await import('@site-engine/engine/theme-registry')
const importRoute = await import('../app/api/editorial/import-snapshot/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }); delete process.env.SITE_THEME_REGISTRY_JSON })

const installed = parseThemeRegistry(themeRegistry)
const selection = (manifest: typeof oldThemeManifest) => ({ id: manifest.name, version: manifest.version, contract: manifest.contract, manifestDigest: getInstalledTheme(installed, manifest.name, manifest.version)!.manifestDigest })

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

  it('imports contract 1.5 public identity and ordered navigation through the ordinary draft capture', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `site-15-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
    const baseline = isolatedFixture(); baseline.settings.contractVersion = '1.5.0'; const desired = structuredClone(baseline)
    desired.settings.legalName = 'Imported Public Identity Incorporated'
    desired.settings.address = { streetAddress: '100 Example Road', addressLocality: 'Toronto', addressRegion: 'ON', postalCode: 'M5V 2T6', addressCountry: 'CA' }
    desired.settings.linkedIn = 'https://www.linkedin.com/company/imported-public-identity'
    desired.settings.incident = { label: 'Incident in progress?', guidance: 'Use the public incident line.' }
    desired.settings.navigation = { header: [{ kind: 'page', id: desired.pages[0]!.id, label: 'Home', style: 'link' }], footer: { columns: [{ heading: 'Company', links: [{ kind: 'section', id: desired.settings.sections[0]!.id, label: 'Company' }] }] } }
    const set = await withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Import public identity', manifest: desired, baseline }) })
    const changes = (await payload.findByID({ collection: 'change-sets', id: String(set.id), overrideAccess: true })).changes as Array<{ collection: string; after: Record<string, unknown> | null }>
    expect(changes).toEqual(expect.arrayContaining([expect.objectContaining({ collection: 'site-settings', after: expect.objectContaining({ legalName: 'Imported Public Identity Incorporated', address: expect.objectContaining({ addressCountry: 'CA' }), navigation: desired.settings.navigation }) })]))
    const persisted = (await payload.find({ collection: 'site-settings', limit: 1, draft: true, overrideAccess: true })).docs[0]
    expect(persisted).toMatchObject({ legalName: 'Imported Public Identity Incorporated', linkedIn: desired.settings.linkedIn, incident: { label: 'Incident in progress?' }, navigation: desired.settings.navigation })
    await withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: owner, id: String(set.id), action: 'discard' }))
  })

  it('captures an installed theme transition atomically with contract 1.5 content', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `theme-import-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
    const baseline = isolatedFixture(); baseline.settings.contractVersion = '1.4.0'; baseline.settings.theme = selection(oldThemeManifest); baseline.settings.themeSettings = { [oldThemeManifest.name]: {} }
    const desired = structuredClone(baseline); desired.settings.contractVersion = '1.5.0'; desired.settings.theme = selection(newThemeManifest); desired.settings.legalName = 'Reviewed Contract Upgrade Incorporated'; desired.pages[0]!.summary = 'Reviewed content imported atomically with the installed contract upgrade.'
    const existing = await payload.find({ collection: 'theme-settings', where: { key: { equals: 'active' } }, limit: 1, depth: 0, draft: true, overrideAccess: true })
    const current = existing.docs[0]
      ? await payload.update({ collection: 'theme-settings', id: existing.docs[0].id, data: { selection: baseline.settings.theme, settings: baseline.settings.themeSettings }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
      : await payload.create({ collection: 'theme-settings', data: { key: 'active', selection: baseline.settings.theme, settings: baseline.settings.themeSettings }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    const set = await withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Upgrade reviewed contract', manifest: desired, baseline }) })
    const changes = (await payload.findByID({ collection: 'change-sets', id: String(set.id), overrideAccess: true })).changes as Array<{ collection: string; id: string; after: Record<string, unknown> }>
    expect(changes).toEqual(expect.arrayContaining([expect.objectContaining({ collection: 'theme-settings', id: current.id, after: expect.objectContaining({ selection: desired.settings.theme }) }), expect.objectContaining({ collection: 'site-settings', after: expect.objectContaining({ legalName: desired.settings.legalName }) }), expect.objectContaining({ collection: 'pages', after: expect.objectContaining({ summary: desired.pages[0]!.summary }) })]))
    const candidate = buildCandidate(baseline, changes as never, changes.map(change => `${change.collection}:${change.id}`), { themeVersion: newThemeManifest.version, engineVersion: 'test', contractVersion: '1.5.0' })
    expect(candidate.settings).toMatchObject({ contractVersion: '1.5.0', theme: desired.settings.theme, legalName: desired.settings.legalName })
    expect(candidate.pages[0]).toMatchObject({ summary: desired.pages[0]!.summary })
    await withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: owner, id: String(set.id), action: 'discard' }))
    expect((await payload.findByID({ collection: 'theme-settings', id: current.id, draft: true, overrideAccess: true })).selection).toEqual(baseline.settings.theme)
  })

  it('imports contract 1.6 generated, contact, unavailable, and bottom navigation with its installed theme', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `navigation-import-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
    const baseline = isolatedFixture(); baseline.settings.contractVersion = '1.5.0'; baseline.settings.theme = selection(newThemeManifest); baseline.settings.themeSettings = { [newThemeManifest.name]: {} }
    const desired = structuredClone(baseline); desired.settings.contractVersion = '1.6.0'; desired.settings.theme = selection(navigationThemeManifest)
    desired.settings.contactEmail = 'hello@example.test'
    desired.settings.navigation = { header: [{ kind: 'unavailable', label: 'Insights', reason: 'Insights are not published.', style: 'link' }], footer: { columns: [{ kind: 'section-pillars', heading: 'Services', sectionId: desired.settings.sections[0]!.id }, { kind: 'contact', heading: 'Contact', fields: ['email', 'address'] }], bottomLinks: [{ kind: 'unavailable', label: 'Privacy', reason: 'Privacy is not published.' }], copyright: '© {year} Imported Site' } }
    const records = await payload.find({ collection: 'theme-settings', where: { key: { equals: 'active' } }, limit: 1, depth: 0, draft: true, overrideAccess: true })
    if (records.docs[0]) await payload.update({ collection: 'theme-settings', id: records.docs[0].id, data: { selection: baseline.settings.theme, settings: baseline.settings.themeSettings }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    else await payload.create({ collection: 'theme-settings', data: { key: 'active', selection: baseline.settings.theme, settings: baseline.settings.themeSettings }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    const set = await withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Import reviewed navigation', manifest: desired, baseline }) })
    const changes = (await payload.findByID({ collection: 'change-sets', id: String(set.id), overrideAccess: true })).changes as Array<{ collection: string; id: string; after: Record<string, unknown> }>
    const candidate = buildCandidate(baseline, changes as never, changes.map(change => `${change.collection}:${change.id}`), { themeVersion: navigationThemeManifest.version, engineVersion: 'test', contractVersion: '1.6.0' })
    expect(candidate.settings).toMatchObject({ contractVersion: '1.6.0', theme: desired.settings.theme, navigation: desired.settings.navigation })
    await withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: owner, id: String(set.id), action: 'discard' }))
  })

  it('rejects unavailable or contract-mismatched selections before writing drafts', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `theme-reject-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
    const baseline = isolatedFixture(); baseline.settings.contractVersion = '1.4.0'; baseline.settings.theme = selection(oldThemeManifest)
    const beforeSections = (await payload.find({ collection: 'sections', limit: 0, pagination: false, draft: true, overrideAccess: true })).totalDocs
    const beforeSets = (await payload.find({ collection: 'change-sets', where: { actor: { equals: owner.id } }, overrideAccess: true })).totalDocs
    const unavailable = structuredClone(baseline); unavailable.settings.contractVersion = '1.5.0'; unavailable.settings.theme = { id: 'unavailable-theme', version: '1.5.0', contract: '1.5.0', manifestDigest: 'f'.repeat(64) }; unavailable.settings.legalName = 'Must not persist'
    await expect(withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Unavailable theme', manifest: unavailable, baseline }) })).rejects.toThrow('not installed exactly as reviewed')
    const missing = structuredClone(baseline); missing.settings.contractVersion = '1.5.0'; delete missing.settings.theme; missing.settings.legalName = 'Must not persist either'
    await expect(withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Missing selection', manifest: missing, baseline }) })).rejects.toThrow('requires a matching installed theme selection')
    const mismatched = structuredClone(baseline); mismatched.settings.theme = selection(newThemeManifest)
    await expect(withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Mismatched selection', manifest: mismatched, baseline }) })).rejects.toThrow()
    expect((await payload.find({ collection: 'sections', limit: 0, pagination: false, draft: true, overrideAccess: true })).totalDocs).toBe(beforeSections)
    expect((await payload.find({ collection: 'change-sets', where: { actor: { equals: owner.id } }, overrideAccess: true })).totalDocs).toBe(beforeSets)
  })

  it('preserves pending and divergent theme draft conflict safety', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `theme-conflict-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
    const baseline = isolatedFixture(); baseline.settings.contractVersion = '1.4.0'; baseline.settings.theme = selection(oldThemeManifest); const desired = structuredClone(baseline); desired.settings.contractVersion = '1.5.0'; desired.settings.theme = selection(newThemeManifest)
    const records = await payload.find({ collection: 'theme-settings', where: { key: { equals: 'active' } }, limit: 1, depth: 0, draft: true, overrideAccess: true })
    const settings = records.docs[0]
      ? await payload.update({ collection: 'theme-settings', id: records.docs[0].id, data: { selection: baseline.settings.theme, settings: {} }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
      : await payload.create({ collection: 'theme-settings', data: { key: 'active', selection: baseline.settings.theme, settings: {} }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    const pending = await payload.create({ collection: 'change-sets', data: { name: 'Pending theme', actor: owner.id, state: 'open', revision: 0, changes: [{ collection: 'theme-settings', id: settings.id }] }, overrideAccess: true, context: { editorialInternal: true } })
    await expect(withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Blocked theme', manifest: desired, baseline }) })).rejects.toThrow('pending editorial change')
    expect((await payload.findByID({ collection: 'theme-settings', id: settings.id, draft: true, overrideAccess: true })).selection).toEqual(baseline.settings.theme)
    await payload.update({ collection: 'change-sets', id: pending.id, data: { state: 'discarded' }, overrideAccess: true, context: { editorialInternal: true } })
    await payload.update({ collection: 'theme-settings', id: settings.id, data: { selection: desired.settings.theme }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    await expect(withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Divergent draft', manifest: desired, baseline }) })).rejects.toThrow('draft theme selection no longer matches')
    await payload.update({ collection: 'theme-settings', id: settings.id, data: { selection: baseline.settings.theme }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
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

  it('submits an imported SEO clear and removes the baseline description from its candidate', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `import-clear-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
    const baseline = isolatedFixture(); baseline.pages[0]!.seoDescription = 'A frozen description that the reviewed import deliberately clears.'
    const desired = structuredClone(baseline); delete desired.pages[0]!.seoDescription
    const set = await withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Clear imported SEO', manifest: desired, baseline }) })
    const changes = (await payload.findByID({ collection: 'change-sets', id: String(set.id), overrideAccess: true })).changes as Array<{ collection: string; id: string; after: Record<string, unknown> | null }>
    expect(changes).toEqual(expect.arrayContaining([expect.objectContaining({ collection: 'pages', id: baseline.pages[0]!.id, after: expect.objectContaining({ seoDescription: null }) })]))
    const candidate = buildCandidate(baseline, changes as never, changes.map(change => `${change.collection}:${change.id}`), { themeVersion: '1.0.0', engineVersion: 'test', contractVersion: '1.0.0' })
    expect(candidate.pages[0]).not.toHaveProperty('seoDescription')
    await expect(withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: owner, id: String(set.id), action: 'submit' }))).resolves.toMatchObject({ state: 'submitted' })
    await payload.update({ collection: 'change-sets', id: String(set.id), data: { state: 'discarded' }, overrideAccess: true, context: { editorialInternal: true } })
  })

  it('rejects draft pages instead of silently promoting them during import', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `import-draft-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
    const baseline = isolatedFixture(); const draft = structuredClone(baseline); draft.pages[0]!.status = 'draft'
    await expect(withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Draft import', manifest: draft, baseline }) })).rejects.toThrow('Only published pages')
    await expect(payload.findByID({ collection: 'pages', id: baseline.pages[0]!.id, draft: true, overrideAccess: true })).rejects.toThrow()
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

describe('section landing import routing', () => {
  it('round-trips root and service landing relations without duplicating the section slug', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `landing-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
    const pending = await payload.find({ collection: 'change-sets', where: { state: { in: ['open', 'submitted', 'changes-requested', 'approved'] } }, limit: 0, pagination: false, overrideAccess: true })
    for (const changeSet of pending.docs) await payload.update({ collection: 'change-sets', id: changeSet.id, data: { state: 'discarded' }, overrideAccess: true, context: { editorialInternal: true } })
    const baseline = isolatedFixture(); const desired = structuredClone(baseline)
    const root = desired.settings.sections[0]!; root.slug = ''; root.summary = undefined
    const serviceID = randomUUID(); const landingID = randomUUID(); const childID = randomUUID()
    desired.settings.sections.push({ id: serviceID, name: 'Services', slug: 'services', landingPageId: landingID, allowedTemplates: ['pillar', 'service'], pageIds: [landingID, childID] })
    const source = desired.pages[0]!
    const landing = { ...structuredClone(source), id: landingID, sectionId: serviceID, title: 'Services', summary: 'A service landing page for the imported neutral route round-trip.', slug: 'services', template: 'pillar' as const, blocks: [] }
    const child = { ...structuredClone(landing), id: childID, parentId: landingID, title: 'Respond', summary: 'A nested service page whose canonical route must omit the landing slug.', slug: 'respond', template: 'service' as const }
    desired.pages.push(child, landing)
    const set = await withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Landing routing', manifest: desired, baseline }) })
    const changes = (await payload.findByID({ collection: 'change-sets', id: String(set.id), overrideAccess: true })).changes as never[]
    const candidate = buildCandidate(baseline, changes, (changes as { collection: string; id: string }[]).map(change => `${change.collection}:${change.id}`), { themeVersion: '1.0.0', engineVersion: 'test', contractVersion: '1.0.0' })
    expect(candidate.settings.sections.find(section => section.id === serviceID)).toMatchObject({ landingPageId: landingID, pageIds: [landingID, childID] })
    const { deriveRoutes } = await import('@site-engine/engine')
    expect(deriveRoutes(candidate).byPath.has('/services')).toBe(true)
    expect(deriveRoutes(candidate).byPath.has('/services/respond')).toBe(true)
    expect(deriveRoutes(candidate).byPath.has('/services/services/respond')).toBe(false)
    await withPayloadTransaction(payload, req => { req.user = owner as never; return transitionChangeSet({ payload, req, actor: owner as never, id: String(set.id), action: 'submit' }) })
  })
})


it('keeps existing page updates when the same import creates a new page', async () => {
  // Earlier conflict scenarios deliberately leave pending singleton captures in this disposable database.
  await payload.update({ collection: 'change-sets', where: { state: { in: ['open', 'submitted', 'changes-requested', 'approved'] } }, data: { state: 'discarded' }, overrideAccess: true, context: { editorialInternal: true } })
  const owner = await payload.create({ collection: 'users', data: { email: `historical-${randomUUID()}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true })
  const baseline = isolatedFixture()
  const initial = await withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Initial mixed-import baseline', manifest: baseline, baseline }) })
  await payload.update({ collection: 'change-sets', id: String(initial.id), data: { state: 'published' }, overrideAccess: true, context: { editorialInternal: true } })
  const desired = structuredClone(baseline)
  const hero = desired.pages[0]!.blocks.find(block => block.type === 'hero')!
  if (hero.type !== 'hero') throw new Error('Expected fixture hero')
  hero.cta = { ...hero.cta!, href: '/updated-target' }
  const newPage = { ...structuredClone(desired.pages[0]!), id: randomUUID(), slug: 'new-page', title: 'New page' }
  desired.pages.push(newPage)
  desired.settings.sections[0]!.pageIds.push(newPage.id)
  const set = await withPayloadTransaction(payload, req => { req.user = owner as never; return importReviewedSnapshot({ payload, req, actor: owner, name: 'Update and create pages', manifest: desired, baseline }) })
  const draft = await payload.findByID({ collection: 'pages', id: desired.pages[0]!.id, depth: 0, draft: true, overrideAccess: true })
  expect(draft.blocks).toEqual(desired.pages[0]!.blocks)
  expect(await payload.findByID({ collection: 'pages', id: newPage.id, draft: true, overrideAccess: true })).toMatchObject({ title: 'New page' })
  await expect(withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: owner, id: String(set.id), action: 'submit' }))).resolves.toMatchObject({ state: 'submitted' })
  await payload.update({ collection: 'change-sets', id: String(set.id), data: { state: 'discarded' }, overrideAccess: true, context: { editorialInternal: true } })
})
