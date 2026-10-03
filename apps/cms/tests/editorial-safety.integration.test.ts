import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { transitionChangeSet } from '../src/editorial'
import { withPayloadTransaction } from '../src/auth-transaction'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-editorial-safety-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'synthetic-editorial-safety-secret-that-is-long-enough'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

async function fixture(label: string) {
  const editor = await payload.create({ collection: 'users', data: { email: `${label}@example.test`, name: label, roles: ['editor'] }, overrideAccess: true })
  const section = await payload.create({ collection: 'sections', data: { name: label, summary: 'A synthetic section for transactional editorial safety regression tests.', slug: label, allowedTemplates: ['standard'] }, overrideAccess: true })
  const page = await payload.create({ collection: 'pages', data: { title: 'Baseline', summary: 'A synthetic baseline page used to verify reversible draft changes.', slug: 'baseline', sectionId: section.id, template: 'standard', blocks: [] }, overrideAccess: true })
  return { editor, page }
}
async function setFor(actorID: string) {
  const result = await payload.find({ collection: 'change-sets', where: { actor: { equals: actorID } }, overrideAccess: true, depth: 0 })
  expect(result.docs).toHaveLength(1)
  return result.docs[0]!
}

describe('ENG-008 discard, stale changes and rollback safety', () => {
  it('restores the original draft and clears optional fields added by the editor', async () => {
    const { editor, page } = await fixture('discard-baseline')
    await payload.update({ collection: 'pages', id: page.id, data: { title: 'Edited', seoDescription: 'An optional description that must disappear on discard.' }, draft: true, user: editor, overrideAccess: false })
    const set = await setFor(editor.id)
    await withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: editor, id: set.id, action: 'discard' }))
    const restored = await payload.findByID({ collection: 'pages', id: page.id, draft: true, overrideAccess: true })
    expect(restored.title).toBe('Baseline')
    expect(restored.seoDescription ?? '').toBe('')
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
})
