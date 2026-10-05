import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { createNamedChangeSet, transitionChangeSet } from '../src/editorial'
import { withPayloadTransaction } from '../src/auth-transaction'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-editorial-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-editorial'
process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE = join(directory, 'bootstrap-token')
writeFileSync(process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE, 'test-only-bootstrap-token')
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

describe('ENG-008 change-set capture and lifecycle', () => {
  it('captures repeated draft saves as one reversible diff and preserves the first baseline', async () => {
    const editor = await payload.create({ collection: 'users', data: { email: 'editor@example.test', name: 'Editor', roles: ['editor'] }, overrideAccess: true })
    const section = await payload.create({ collection: 'sections', data: { name: 'Editorial', summary: 'This section exists to exercise durable editorial capture in real SQLite.', slug: 'editorial', allowedTemplates: ['standard'] }, user: editor, overrideAccess: false })
    const page = await payload.create({ collection: 'pages', data: { title: 'Original title', summary: 'This draft page is used to prove that change capture keeps the first baseline.', slug: 'original', sectionId: section.id, template: 'standard' }, user: editor, overrideAccess: false })
    await payload.create({ collection: 'redirects', data: { from: '/original', to: '/editorial/original' }, user: editor, overrideAccess: false })
    await payload.update({ collection: 'pages', id: page.id, data: { title: 'First revision' }, draft: true, user: editor, overrideAccess: false })
    await payload.update({ collection: 'pages', id: page.id, data: { title: 'Second revision' }, draft: true, user: editor, overrideAccess: false })
    const sets = await payload.find({ collection: 'change-sets', where: { actor: { equals: editor.id } }, overrideAccess: true })
    expect(sets.totalDocs).toBe(1)
    const changes = (sets.docs[0]?.changes as { collection: string; before: { title?: string } | null; after: { title?: string } }[]).filter((change) => change.collection === 'pages')
    expect(changes).toHaveLength(1)
    expect(changes[0]?.before).toBeNull()
    expect(changes[0]?.after.title).toBe('Second revision')
    expect((sets.docs[0]?.changes as { collection: string }[]).map((change) => change.collection)).toEqual(expect.arrayContaining(['sections', 'pages', 'redirects']))
    const submitted = await withPayloadTransaction(payload, (req) => transitionChangeSet({ payload, req, actor: editor, id: sets.docs[0]!.id, action: 'submit' }))
    expect(submitted.state).toBe('submitted')
    const notification = await payload.find({ collection: 'notification-outbox', where: { sourceID: { equals: sets.docs[0]!.id } }, limit: 1, depth: 0, overrideAccess: true })
    expect(notification.docs[0]).toMatchObject({ kind: 'change-set-submitted', recipientRules: ['approver'], channels: ['email'], state: 'queued' })
  })

  it('uses server-owned transitions, reviewer roles, and a transactional audit entry', async () => {
    const editor = await payload.create({ collection: 'users', data: { email: 'editor-two@example.test', name: 'Editor Two', roles: ['editor'] }, overrideAccess: true })
    const reviewer = await payload.create({ collection: 'users', data: { email: 'reviewer@example.test', name: 'Reviewer', roles: ['approver'] }, overrideAccess: true })
    const reviewerSet = await withPayloadTransaction(payload, (req) => createNamedChangeSet(payload, req, reviewer, 'Approver page edits'))
    expect(reviewerSet).toMatchObject({ actor: expect.objectContaining({ id: reviewer.id }), state: 'open', revision: 0 })
    const set = await withPayloadTransaction(payload, (req) => createNamedChangeSet(payload, req, editor, 'Reviewable changes'))
    await expect(withPayloadTransaction(payload, (req) => transitionChangeSet({ payload, req, actor: editor, id: set.id as string, action: 'request-changes' }))).rejects.toThrow('Reviewer role required')
    await expect(withPayloadTransaction(payload, (req) => transitionChangeSet({ payload, req, actor: editor, id: set.id as string, action: 'submit' }))).rejects.toThrow('Add at least one draft change')
    await withPayloadTransaction(payload, (req) => payload.update({ collection: 'change-sets', id: set.id as string, data: { state: 'submitted' }, overrideAccess: true, req, context: { editorialInternal: true } }))
    const requested = await withPayloadTransaction(payload, (req) => transitionChangeSet({ payload, req, actor: reviewer, id: set.id as string, action: 'request-changes' }))
    expect(requested.state).toBe('changes-requested')
    const audit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'editorial.change_set_request-changes' } }, overrideAccess: true })
    expect(audit.totalDocs).toBe(1)
  })
})
