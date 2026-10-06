import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { changeSetConflicts, resolveChangeSetConflicts, transitionChangeSet } from '../src/editorial'
import { withPayloadTransaction } from '../src/auth-transaction'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-editorial-safety-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'synthetic-editorial-safety-secret-that-is-long-enough'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) }, 60_000)
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

async function fixture(label: string, seoDescription?: string) {
  const editor = await payload.create({ collection: 'users', data: { email: `${label}@example.test`, name: label, roles: ['editor'] }, overrideAccess: true })
  const section = await payload.create({ collection: 'sections', data: { name: label, summary: 'A synthetic section for transactional editorial safety regression tests.', slug: label, allowedTemplates: ['standard'] }, overrideAccess: true })
  const page = await payload.create({ collection: 'pages', data: { title: 'Baseline', summary: 'A synthetic baseline page used to verify reversible draft changes.', slug: 'baseline', sectionId: section.id, template: 'standard', blocks: [], ...(seoDescription ? { seoDescription } : {}) }, overrideAccess: true })
  return { editor, page }
}
async function setFor(actorID: string) {
  const result = await payload.find({ collection: 'change-sets', where: { actor: { equals: actorID } }, overrideAccess: true, depth: 0 })
  expect(result.docs).toHaveLength(1)
  return result.docs[0]!
}

describe('ENG-008 discard, stale changes and rollback safety', () => {
  it('keeps an unset section landing relation stable after persistence and refresh', async () => {
    const { editor } = await fixture('section-empty-landing')
    await payload.create({ collection: 'sections', data: { name: 'No landing selected', slug: 'no-landing-selected', allowedTemplates: ['standard'] }, draft: true, user: editor, overrideAccess: false })
    const set = await setFor(editor.id)
    const change = (set.changes as Array<{ after: Record<string, unknown> }>)[0]!
    expect(Object.hasOwn(change.after, 'landingPageId')).toBe(false)
    await payload.update({ collection: 'change-sets', id: set.id, data: { createdAt: '2000-01-01T00:00:00.000Z' }, overrideAccess: true, context: { editorialInternal: true } })
    await withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: editor, id: set.id, action: 'refresh' }))
    await expect(withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: editor, id: set.id, action: 'submit' }))).resolves.toMatchObject({ state: 'submitted' })
  })
  it('restores the original draft and clears optional fields added by the editor', async () => {
    const { editor, page } = await fixture('discard-baseline')
    await payload.update({ collection: 'pages', id: page.id, data: { title: 'Edited', seoDescription: 'An optional description that must disappear on discard.', noindex: true }, draft: true, user: editor, overrideAccess: false })
    const set = await setFor(editor.id)
    await withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: editor, id: set.id, action: 'discard' }))
    const restored = await payload.findByID({ collection: 'pages', id: page.id, draft: true, overrideAccess: true })
    expect(restored.title).toBe('Baseline')
    expect(restored.seoDescription ?? '').toBe('')
    expect(restored.noindex).toBe(false)
    expect((await setFor(editor.id)).state).toBe('discarded')
  })
  it('refuses stale refresh and discard rather than overwriting a second editor', async () => {
    const { editor, page } = await fixture('concurrent-draft')
    const other = await payload.create({ collection: 'users', data: { email: 'other-editor@example.test', name: 'Other editor', roles: ['editor'] }, overrideAccess: true })
    await payload.update({ collection: 'pages', id: page.id, data: { title: 'First edit' }, draft: true, user: editor, overrideAccess: false })
    const first = await setFor(editor.id)
    await payload.update({ collection: 'pages', id: page.id, data: { title: 'Second editor edit' }, draft: true, user: other, overrideAccess: false })
    for (const action of ['refresh', 'discard', 'submit'] as const) {
      await expect(withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: editor, id: first.id, action }))).rejects.toThrow(/conflict|stale/i)
    }
    expect((await payload.findByID({ collection: 'pages', id: page.id, draft: true, overrideAccess: true })).title).toBe('Second editor edit')
    expect((await setFor(other.id)).state).toBe('open')
  })
  it('refreshes an aged but unchanged set without immediately expiring it again', async () => {
    const { editor, page } = await fixture('aged-draft')
    await payload.update({ collection: 'pages', id: page.id, data: { title: 'Review me' }, draft: true, user: editor, overrideAccess: false })
    const set = await setFor(editor.id)
    await payload.update({ collection: 'change-sets', id: set.id, data: { createdAt: '2000-01-01T00:00:00.000Z' }, overrideAccess: true, context: { editorialInternal: true } })
    await expect(withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: editor, id: set.id, action: 'submit' }))).rejects.toThrow(/stale/i)
    await withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: editor, id: set.id, action: 'refresh' }))
    const submitted = await withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: editor, id: set.id, action: 'submit' }))
    expect(submitted.state).toBe('submitted')
  })
  it('keeps an explicit optional-field clear while refreshing an aged page change set', async () => {
    const { editor, page } = await fixture('aged-clear', 'A baseline optional description that is deliberately cleared in review.')
    await payload.update({ collection: 'pages', id: page.id, data: { seoDescription: null }, draft: true, user: editor, overrideAccess: false })
    const set = await setFor(editor.id)
    expect(set.changes).toEqual(expect.arrayContaining([expect.objectContaining({ collection: 'pages', after: expect.objectContaining({ seoDescription: null }) })]))
    await payload.update({ collection: 'change-sets', id: set.id, data: { createdAt: '2000-01-01T00:00:00.000Z' }, overrideAccess: true, context: { editorialInternal: true } })
    await withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: editor, id: set.id, action: 'refresh' }))
    const refreshed = await setFor(editor.id)
    expect(refreshed.changes).toEqual(expect.arrayContaining([expect.objectContaining({ collection: 'pages', after: expect.objectContaining({ seoDescription: null }) })]))
    await expect(withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: editor, id: set.id, action: 'submit' }))).resolves.toMatchObject({ state: 'submitted' })
  })
  it('rolls back content restoration, state, and audit when the outer transaction fails', async () => {
    const { editor, page } = await fixture('discard-rollback')
    await payload.update({ collection: 'pages', id: page.id, data: { title: 'Keep this edit' }, draft: true, user: editor, overrideAccess: false })
    const set = await setFor(editor.id)
    const beforeAudit = await payload.count({ collection: 'audit-events', overrideAccess: true })
    await expect(withPayloadTransaction(payload, async req => {
      await transitionChangeSet({ payload, req, actor: editor, id: set.id, action: 'discard' })
      throw new Error('Injected failure before transaction commit')
    })).rejects.toThrow('Injected failure')
    expect((await payload.findByID({ collection: 'pages', id: page.id, draft: true, overrideAccess: true })).title).toBe('Keep this edit')
    expect((await setFor(editor.id)).state).toBe('open')
    expect((await payload.count({ collection: 'audit-events', overrideAccess: true })).totalDocs).toBe(beforeAudit.totalDocs)
  })
  it('requires the owning editor to explicitly resolve a guarded stale draft without clobbering another field', async () => {
    const { editor, page } = await fixture('resolve-reapply')
    const other = await payload.create({ collection: 'users', data: { email: 'resolve-other@example.test', name: 'Other editor', roles: ['editor'] }, overrideAccess: true })
    await payload.update({ collection: 'pages', id: page.id, data: { title: 'Proposed title' }, draft: true, user: editor, overrideAccess: false })
    const set = await setFor(editor.id)
    await payload.update({ collection: 'pages', id: page.id, data: { title: 'Other editor current title', summary: 'Other editor current summary remains after resolution.' }, draft: true, user: other, overrideAccess: false })
    await expect(withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: editor, id: set.id, action: 'submit' }))).rejects.toThrow(/stale/i)
    const view = await withPayloadTransaction(payload, req => changeSetConflicts({ payload, req, actor: editor, id: set.id }))
    expect(view.conflicts).toEqual([expect.objectContaining({ collection: 'pages', id: page.id, before: expect.objectContaining({ title: 'Baseline' }), proposed: expect.objectContaining({ title: 'Proposed title' }), current: expect.objectContaining({ title: 'Other editor current title', summary: 'Other editor current summary remains after resolution.' }), canReapply: true })])
    await expect(withPayloadTransaction(payload, req => resolveChangeSetConflicts({ payload, req, actor: other, id: set.id, expectedRevision: view.revision, resolutions: [] }))).rejects.toThrow(/Only the editor/i)
    const resolved = await withPayloadTransaction(payload, req => resolveChangeSetConflicts({ payload, req, actor: editor, id: set.id, expectedRevision: view.revision, resolutions: view.conflicts.map((conflict) => ({ collection: conflict.collection, id: conflict.id, currentHash: conflict.currentHash, choice: 'reapply-proposed' as const })) }))
    expect(resolved).toMatchObject({ state: 'stale', revision: view.revision + 1, preview: null, quality: null })
    const current = await payload.findByID({ collection: 'pages', id: page.id, draft: true, overrideAccess: true })
    expect(current).toMatchObject({ title: 'Proposed title', summary: 'Other editor current summary remains after resolution.' })
    await expect(withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: editor, id: set.id, action: 'refresh' }))).resolves.toMatchObject({ state: 'open' })
    await expect(withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: editor, id: set.id, action: 'submit' }))).resolves.toMatchObject({ state: 'submitted' })
    const audit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'editorial.change_set_conflicts_resolved' } }, limit: 1, depth: 0, overrideAccess: true })
    expect(audit.docs[0]).toMatchObject({ user: editor.id, actor: editor.id, detail: { changeSet: set.id, retained: 0, reapplied: 1 } })
  })

  it('keeps the current draft when the owner deliberately retains it and rejects a stale conflict hash', async () => {
    const { editor, page } = await fixture('resolve-retain')
    const other = await payload.create({ collection: 'users', data: { email: 'retain-other@example.test', name: 'Other editor', roles: ['editor'] }, overrideAccess: true })
    await payload.update({ collection: 'pages', id: page.id, data: { title: 'Original proposal' }, draft: true, user: editor, overrideAccess: false })
    const set = await setFor(editor.id)
    await payload.update({ collection: 'pages', id: page.id, data: { title: 'Current editor draft' }, draft: true, user: other, overrideAccess: false })
    await expect(withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: editor, id: set.id, action: 'submit' }))).rejects.toThrow(/stale/i)
    const view = await withPayloadTransaction(payload, req => changeSetConflicts({ payload, req, actor: editor, id: set.id }))
    await payload.update({ collection: 'pages', id: page.id, data: { title: 'Current editor changed again' }, draft: true, user: other, overrideAccess: false })
    await expect(withPayloadTransaction(payload, req => resolveChangeSetConflicts({ payload, req, actor: editor, id: set.id, expectedRevision: view.revision, resolutions: view.conflicts.map((conflict) => ({ collection: conflict.collection, id: conflict.id, currentHash: conflict.currentHash, choice: 'retain-current' as const })) }))).rejects.toThrow(/changed while you were reviewing/i)
    expect((await payload.findByID({ collection: 'pages', id: page.id, draft: true, overrideAccess: true })).title).toBe('Current editor changed again')
    const currentView = await withPayloadTransaction(payload, req => changeSetConflicts({ payload, req, actor: editor, id: set.id }))
    await withPayloadTransaction(payload, req => resolveChangeSetConflicts({ payload, req, actor: editor, id: set.id, expectedRevision: currentView.revision, resolutions: currentView.conflicts.map((conflict) => ({ collection: conflict.collection, id: conflict.id, currentHash: conflict.currentHash, choice: 'retain-current' as const })) }))
    const resolved = await payload.findByID({ collection: 'change-sets', id: set.id, depth: 0, overrideAccess: true })
    expect(resolved.changes).toEqual([])
    expect((await payload.findByID({ collection: 'pages', id: page.id, draft: true, overrideAccess: true })).title).toBe('Current editor changed again')
  })

})
