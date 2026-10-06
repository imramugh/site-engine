import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { getPayload } from 'payload'
import { withPayloadTransaction } from '../src/auth-transaction'
import { transitionChangeSet, snapshot } from '../src/editorial'
import { buildCandidate, canonicalHash } from '../src/publishing'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'
import { deriveRoutes } from '@site-engine/engine'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-reviewed-rollback-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'reviewed-rollback-secret-that-is-long-enough'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
const { default: config } = await import('../payload.config.js')
const rollback = await import('../src/change-log.js')
let payload: any, owner: any, sequence = 0
beforeAll(async () => { payload = await getPayload({ config }); owner = await payload.create({ collection: 'users', data: { email: 'rollback-owner@example.test', name: 'Rollback Owner', roles: ['owner'] }, overrideAccess: true }) }, 60_000)
afterAll(async () => { await payload.destroy(); rmSync(directory, { recursive: true, force: true }) })

async function auth() {
  const token = newOpaqueToken(), now = new Date().toISOString()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: owner.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  return new Headers({ cookie: `${cookieName(SESSION_COOKIE)}=${token}` })
}
function fixture() {
  const value: any = structuredClone(neutralFixture)
  const sections = new Map(value.settings.sections.map((s: any) => [s.id, randomUUID()])), pages = new Map(value.pages.map((p: any) => [p.id, randomUUID()]))
  for (const s of value.settings.sections) { s.id = sections.get(s.id); s.slug = `${s.slug}-${s.id.slice(0, 8)}`; s.pageIds = s.pageIds.map((id: string) => pages.get(id) ?? id); if (s.landingPageId) s.landingPageId = pages.get(s.landingPageId) ?? s.landingPageId }
  for (const p of value.pages) { p.id = pages.get(p.id); p.sectionId = sections.get(p.sectionId) ?? p.sectionId; if (p.parentId) p.parentId = pages.get(p.parentId) ?? p.parentId; p.slug = `${p.slug}-${p.id.slice(0, 8)}` }
  value.settings.homepageId = pages.get(value.settings.homepageId) ?? value.settings.homepageId
  return value
}
async function seed(manifest: any) {
  for (const s of manifest.settings.sections) await payload.create({ collection: 'sections', data: { ...s, pageIds: [], landingPageId: undefined }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
  for (const p of manifest.pages) await payload.create({ collection: 'pages', data: { ...p, status: p.status === 'archived' ? 'archived' : 'draft' }, draft: true, overrideAccess: true, context: { editorialInternal: true, reviewedSnapshotImport: true, archiveInternal: true } })
  for (const s of manifest.settings.sections) await payload.update({ collection: 'sections', id: s.id, data: { pageIds: s.pageIds, ...(s.landingPageId ? { landingPageId: s.landingPageId } : {}) }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
}
function capture(before: any | null, after: any | null, collection = 'pages') {
  const a = before && snapshot(collection as any, before), b = after && snapshot(collection as any, after)
  return { collection, id: String((after ?? before).id), before: a, after: b, beforeHash: a ? canonicalHash(a) : null, afterHash: b ? canonicalHash(b) : null }
}
async function release(manifest: any, changes: any[]) {
  const number = ++sequence
  const set = await payload.create({ collection: 'change-sets', data: { name: `Release ${number}`, actor: owner.id, state: 'published', revision: 1, changes }, overrideAccess: true, context: { editorialInternal: true } })
  const publishedSnapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: canonicalHash(manifest), changeSet: set.id, reviewRevision: 1, changeHash: canonicalHash(changes), manifest, themeVersion: 'test', engineVersion: 'test', contractVersion: manifest.settings.contractVersion, approvedBy: owner.id, baselineSequence: number - 1 }, overrideAccess: true, context: { editorialInternal: true } })
  const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: randomUUID(), sequence: number, snapshot: publishedSnapshot.id, changeSet: set.id, reviewRevision: 1, changeHash: canonicalHash(changes), includedChangeKeys: changes.map(c => `${c.collection}:${c.id}`), status: 'completed', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  return payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence: number, snapshot: publishedSnapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { checks: [] }, artifact: { digest: 'a'.repeat(64), sourceContentHash: publishedSnapshot.contentHash, themeVersion: 'test', engineVersion: 'test', contractVersion: manifest.settings.contractVersion, checks: [] } }, overrideAccess: true, context: { editorialInternal: true } })
}
function candidate(current: any, set: any) { const changes = set.changes as any[]; return buildCandidate(current, changes, changes.map(c => `${c.collection}:${c.id}`), { themeVersion: 'test', engineVersion: 'test', contractVersion: current.settings.contractVersion }) }
function pathFor(manifest: any, pageID: string) { return deriveRoutes(manifest).routes.find(route => route.page.id === pageID)!.path }
async function currentPage(change: (before: any, after: any) => void) {
  const before = fixture(), after = structuredClone(before); change(before, after); await seed(after); await release(before, []); const current = await release(after, [capture(before.pages[0], after.pages[0])]); return { before, after, current }
}

describe('ENG-010 reviewed rollback', () => {
  it('reverses one selected approved change without changing another approved draft', async () => {
    const before = fixture(), after = structuredClone(before), second = { ...after.pages[0], id: randomUUID(), slug: `second-${randomUUID().slice(0, 8)}`, title: 'Second reviewed page' }
    before.pages.push(structuredClone(second)); after.pages.push(second); before.settings.sections[0].pageIds.push(second.id); after.settings.sections[0].pageIds.push(second.id)
    after.pages[0].summary = 'first current'; after.pages[1].summary = 'second current'; await seed(after); await release(before, [])
    const current = await release(after, [capture(before.pages[0], after.pages[0]), capture(before.pages[1], after.pages[1])])
    const set: any = await rollback.prepareReviewedRollback(payload, owner, await auth(), String(current.id), { mode: 'change', changeKeys: [`pages:${after.pages[0].id}`] })
    expect(candidate(after, set).pages).toEqual(expect.arrayContaining([expect.objectContaining({ id: after.pages[0].id, summary: before.pages[0].summary }), expect.objectContaining({ id: second.id, summary: 'second current' })]))
  })
  it('reverses every approved change in a whole-release rollback', async () => {
    const before = fixture(), after = structuredClone(before), second = { ...after.pages[0], id: randomUUID(), slug: `whole-${randomUUID().slice(0, 8)}`, title: 'Whole rollback page' }
    before.pages.push(structuredClone(second)); after.pages.push(second); before.settings.sections[0].pageIds.push(second.id); after.settings.sections[0].pageIds.push(second.id); after.pages[0].summary = 'first whole'; after.pages[1].summary = 'second whole'
    await seed(after); await release(before, []); const current = await release(after, [capture(before.pages[0], after.pages[0]), capture(before.pages[1], after.pages[1])])
    const set: any = await rollback.prepareReviewedRollback(payload, owner, await auth(), String(current.id), { mode: 'release' })
    expect(candidate(after, set).pages).toEqual(expect.arrayContaining([expect.objectContaining({ id: after.pages[0].id, summary: before.pages[0].summary }), expect.objectContaining({ id: second.id, summary: before.pages[1].summary })]))
  })
  it('keeps an approved new page as a guarded draft while rollback removes it from the candidate', async () => {
    const before = fixture(), after = structuredClone(before), added = { ...after.pages[0], id: randomUUID(), slug: `added-${randomUUID().slice(0, 8)}`, title: 'Newly approved page' }
    after.pages.push(added); after.settings.sections[0].pageIds.push(added.id); await seed(after); await release(before, []); const current = await release(after, [capture(before.settings.sections[0], after.settings.sections[0], 'sections'), capture(null, added)])
    const set: any = await rollback.prepareReviewedRollback(payload, owner, await auth(), String(current.id), { mode: 'release' }), change = set.changes.find((item: any) => item.collection === 'pages')
    expect(change).toMatchObject({ id: added.id, after: null, retainedDraftHash: expect.any(String) }); expect(await payload.findByID({ collection: 'pages', id: added.id, draft: true, overrideAccess: true })).toMatchObject({ title: added.title }); expect(candidate(after, set).pages.map((p: any) => p.id)).not.toContain(added.id)
  })
  it('restores an archived page to its active draft', async () => {
    const before = fixture(), after = structuredClone(before), target = { ...after.pages[0], id: randomUUID(), slug: `archived-${randomUUID().slice(0, 8)}`, title: 'Archived rollback target', status: 'published' }
    before.pages.push(structuredClone(target)); after.pages.push(target); before.settings.sections[0].pageIds.push(target.id); after.settings.sections[0].pageIds.push(target.id); after.pages[1].status = 'archived'
    const oldPath = pathFor(before, target.id); after.redirects.push({ from: oldPath, to: '/', status: 301 }); await seed(after); await payload.create({ collection: 'redirects', data: after.redirects[0], draft: true, overrideAccess: true, context: { editorialInternal: true, reviewedSnapshotImport: true } }); await release(before, []); const current = await release(after, [capture(before.pages[1], after.pages[1])])
    const set: any = await rollback.prepareReviewedRollback(payload, owner, await auth(), String(current.id), { mode: 'release' })
    expect(await payload.findByID({ collection: 'pages', id: target.id, draft: true, overrideAccess: true })).toMatchObject({ status: 'draft' }); expect(candidate(after, set).pages).toEqual(expect.arrayContaining([expect.objectContaining({ id: target.id, status: before.pages[1].status })])); expect(set.changes).toEqual(expect.arrayContaining([expect.objectContaining({ collection: 'redirects', before: expect.objectContaining({ from: oldPath }), after: null })]))
  })
  it('reverses an approved unarchive back to an archived draft', async () => {
    const before = fixture(), after = structuredClone(before), target = { ...after.pages[0], id: randomUUID(), parentId: after.pages[0].id, slug: `unarchived-${randomUUID().slice(0, 8)}`, title: 'Unarchive rollback target', status: 'archived' }
    before.pages.push(structuredClone(target)); after.pages.push(target); before.settings.sections[0].pageIds.push(target.id); after.settings.sections[0].pageIds.push(target.id); after.pages[1].status = 'published'
    await seed(after); await release(before, []); const current = await release(after, [capture(before.pages[1], after.pages[1])])
    const set: any = await rollback.prepareReviewedRollback(payload, owner, await auth(), String(current.id), { mode: 'release' })
    expect(await payload.findByID({ collection: 'pages', id: target.id, draft: true, overrideAccess: true })).toMatchObject({ status: 'archived' }); expect(candidate(after, set).pages).toEqual(expect.arrayContaining([expect.objectContaining({ id: target.id, status: 'archived' })]))
  })
  it('restores a renamed page old path and removes the colliding derived redirect', async () => {
    const before = fixture(), after = structuredClone(before), target = { ...after.pages[0], id: randomUUID(), slug: `old-${randomUUID().slice(0, 8)}`, title: 'Renamed rollback target', status: 'published' }
    before.pages.push(structuredClone(target)); after.pages.push(target); before.settings.sections[0].pageIds.push(target.id); after.settings.sections[0].pageIds.push(target.id); const oldPath = pathFor(before, target.id)
    after.pages[1].slug = `new-${randomUUID().slice(0, 8)}`; const newPath = pathFor(after, target.id); after.redirects.push({ from: oldPath, to: newPath, status: 301 })
    await seed(after); await payload.create({ collection: 'redirects', data: after.redirects[0], draft: true, overrideAccess: true, context: { editorialInternal: true, reviewedSnapshotImport: true } }); await release(before, []); const current = await release(after, [capture(before.pages[1], after.pages[1])])
    const set: any = await rollback.prepareReviewedRollback(payload, owner, await auth(), String(current.id), { mode: 'release' }), proposed = candidate(after, set)
    expect(proposed.pages).toEqual(expect.arrayContaining([expect.objectContaining({ id: target.id, slug: before.pages[1].slug })])); expect(proposed.redirects.map((redirect: any) => redirect.from)).not.toContain(oldPath); expect(set.changes).toEqual(expect.arrayContaining([expect.objectContaining({ collection: 'redirects', before: expect.objectContaining({ from: oldPath, to: newPath }), after: null })]))
  })
  it('rejects an excluded key and a pending change for a rollback record', async () => {
    const { before, after, current } = await currentPage((_before, value) => { value.pages[0].summary = 'pending target' })
    await expect(rollback.prepareReviewedRollback(payload, owner, await auth(), String(current.id), { mode: 'change', changeKeys: ['pages:not-in-release'] })).rejects.toThrow('not included')
    await payload.create({ collection: 'change-sets', data: { name: 'Pending conflict', actor: owner.id, state: 'open', revision: 0, changes: [capture(before.pages[0], after.pages[0])] }, overrideAccess: true, context: { editorialInternal: true } })
    await expect(rollback.prepareReviewedRollback(payload, owner, await auth(), String(current.id), { mode: 'release' })).rejects.toThrow('pending editorial change')
  })
  it('does not overwrite a rejected or stale later draft while preparing rollback', async () => {
    for (const state of ['rejected', 'stale']) {
      const { before, after, current } = await currentPage((_before, value) => { value.pages[0].summary = `${state} approved summary` })
      await payload.create({ collection: 'change-sets', data: { name: `${state} later edit`, actor: owner.id, state, revision: 1, changes: [capture(before.pages[0], after.pages[0])] }, overrideAccess: true, context: { editorialInternal: true } })
      const later = `${state} later draft survives`
      await payload.update({ collection: 'pages', id: after.pages[0].id, data: { summary: later }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
      await expect(rollback.prepareReviewedRollback(payload, owner, await auth(), String(current.id), { mode: 'release' })).rejects.toThrow('later draft edit')
      expect(await payload.findByID({ collection: 'pages', id: after.pages[0].id, draft: true, overrideAccess: true })).toMatchObject({ summary: later })
    }
  })
  it('submits a prepared rollback and discards another back to the approved draft', async () => {
    const { after, current } = await currentPage((_before, value) => { value.pages[0].summary = 'submit and discard current' })
    const discarded: any = await rollback.prepareReviewedRollback(payload, owner, await auth(), String(current.id), { mode: 'release' })
    await withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: owner, id: discarded.id, action: 'discard' }))
    expect(await payload.findByID({ collection: 'pages', id: after.pages[0].id, draft: true, overrideAccess: true })).toMatchObject({ summary: 'submit and discard current' })
    const submitted: any = await rollback.prepareReviewedRollback(payload, owner, await auth(), String(current.id), { mode: 'release' })
    await expect(withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: owner, id: submitted.id, action: 'submit' }))).resolves.toMatchObject({ state: 'submitted' })
  })
  it('marks a guarded deletion rollback stale after a later draft edit', async () => {
    const before = fixture(), after = structuredClone(before), added = { ...after.pages[0], id: randomUUID(), slug: `stale-${randomUUID().slice(0, 8)}`, title: 'Stale guarded page' }
    after.pages.push(added); after.settings.sections[0].pageIds.push(added.id); await seed(after); await release(before, []); const current = await release(after, [capture(before.settings.sections[0], after.settings.sections[0], 'sections'), capture(null, added)])
    const set: any = await rollback.prepareReviewedRollback(payload, owner, await auth(), String(current.id), { mode: 'release' }); await payload.update({ collection: 'pages', id: added.id, data: { title: 'Later draft edit' }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    await expect(withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: owner, id: set.id, action: 'submit' }))).rejects.toThrow(/stale|conflict/i)
  })
  it('turns an initially created style guide into a guarded reviewed removal', async () => {
    const before = fixture(), after = structuredClone(before)
    delete before.styleGuide
    after.styleGuide = { bannedPhrases: ['synthetic banned phrase'], preferredTerms: [{ avoid: 'color', prefer: 'colour' }], canadianSpelling: 'warn', maximumSentenceWords: 24, minimumReadingEase: 42 }
    await seed(after)
    const guide: any = await payload.create({ collection: 'style-guides', data: after.styleGuide, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    await release(before, [])
    const current = await release(after, [capture(null, guide, 'style-guides')])

    const set: any = await rollback.prepareReviewedRollback(payload, owner, await auth(), String(current.id), { mode: 'release' })
    const change = set.changes.find((item: any) => item.collection === 'style-guides')
    expect(change).toMatchObject({ id: guide.id, after: null, retainedDraftHash: expect.any(String) })
    expect(candidate(after, set).styleGuide).toBeUndefined()
    expect(await payload.findByID({ collection: 'style-guides', id: guide.id, draft: true, overrideAccess: true })).toMatchObject({ bannedPhrases: ['synthetic banned phrase'], canadianSpelling: 'warn' })
  })
  it('restores the prior published site name when the current singleton was first captured as created', async () => {
    const before = fixture(), after = structuredClone(before)
    before.settings.siteName = 'Prior published site name'
    after.settings.siteName = 'Current first-created site name'
    await seed(after)
    const settings: any = await payload.create({ collection: 'site-settings', data: { siteName: after.settings.siteName, defaultLocale: after.settings.defaultLocale, homepageId: after.settings.homepageId }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    await release(before, [])
    const current = await release(after, [capture(null, settings, 'site-settings')])

    const set: any = await rollback.prepareReviewedRollback(payload, owner, await auth(), String(current.id), { mode: 'release' })
    const change = set.changes.find((item: any) => item.collection === 'site-settings')
    expect(change).toMatchObject({ id: settings.id, before: expect.objectContaining({ siteName: after.settings.siteName }), after: expect.objectContaining({ siteName: before.settings.siteName }) })
    expect(candidate(after, set).settings.siteName).toBe(before.settings.siteName)
    expect(await payload.findByID({ collection: 'site-settings', id: settings.id, draft: true, overrideAccess: true })).toMatchObject({ siteName: before.settings.siteName })
  })
})
