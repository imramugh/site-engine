import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { getPayload } from 'payload'
import { withPayloadTransaction } from '../src/auth-transaction'
import { applyDirectEdit, directEditValueHash, executeDirectEdit } from '../src/direct-edit'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-direct-edit-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-direct-edit'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE = join(directory, 'bootstrap-token')
writeFileSync(process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE, 'test-only-bootstrap-token')
const { default: config } = await import('../payload.config.js')
const directRoute = await import('../app/api/editorial/direct-edit/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>

const heroID = '10000000-0000-4000-8000-000000000001'
async function actor(role: 'owner' | 'editor' | 'approver' = 'editor') {
  return payload.create({ collection: 'users', data: { email: `${role}-${newOpaqueToken()}@example.test`, name: role, roles: [role] }, overrideAccess: true })
}
async function session(user: { id: string }) {
  const token = newOpaqueToken(); const now = new Date().toISOString()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  return `${cookieName(SESSION_COOKIE)}=${token}`
}
async function fixture(user: { id: string; roles?: string[] }) {
  const unique = randomUUID().replaceAll('-', '').slice(0, 12)
  const section = await payload.create({ collection: 'sections', data: { name: `Section ${unique}`, slug: `section-${unique}`, allowedTemplates: ['landing', 'standard'] }, overrideAccess: true, context: { editorialInternal: true } })
  const page = await payload.create({ collection: 'pages', data: { title: 'Direct edit page', summary: 'A synthetic page with enough summary text for direct edit tests.', slug: `page-${unique}`, sectionId: section.id, template: 'landing', blocks: [{ id: heroID, type: 'hero', heading: 'Original heading', body: 'Original hero body.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, overrideAccess: true, context: { editorialInternal: true } })
  const set = await payload.create({ collection: 'change-sets', data: { name: 'Direct edit set', state: 'open', actor: user.id, revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
  return { section, page, set }
}
function edit(pageID: string, setID: string, value = 'Updated heading') { return { pageID, blockID: heroID, field: 'heading' as const, value, expectedValueHash: directEditValueHash('Original heading'), changeSetID: setID } }

beforeAll(async () => { payload = await getPayload({ config }) }, 30_000)
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

describe('ENG-026 draft-only direct hero edits', () => {
  it('uses the same working-draft path as ordinary editing, captures an allowed hero field, and replays safely', async () => {
    const editor = await actor(); const current = await fixture(editor)
    await payload.update({ collection: 'pages', id: current.page.id, data: { title: 'Ordinary working draft change' }, draft: true, user: editor, overrideAccess: false })
    const ordinaryDraft = await payload.findByID({ collection: 'pages', id: current.page.id, draft: true, overrideAccess: true })
    expect(ordinaryDraft._status).toBe('draft')
    const cookie = await session(editor)
    const response = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', cookie, 'content-type': 'application/json' }, body: JSON.stringify(edit(current.page.id, current.set.id)) }))
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ pageID: current.page.id, changeSetID: current.set.id, replayed: false, noOp: false })
    const replay = await withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: edit(current.page.id, current.set.id) }))
    expect(replay).toMatchObject({ replayed: true, noOp: false })
    const page = await payload.findByID({ collection: 'pages', id: current.page.id, draft: true, overrideAccess: true })
    expect((page.blocks as { heading: string }[])[0]?.heading).toBe('Updated heading'); expect(page.status).toBe('draft')
    const set = await payload.findByID({ collection: 'change-sets', id: current.set.id, overrideAccess: true })
    expect(set.state).toBe('open'); expect(set.changes).toEqual(expect.arrayContaining([expect.objectContaining({ collection: 'pages', id: current.page.id })]))
    expect((await payload.count({ collection: 'published-releases', overrideAccess: true })).totalDocs).toBe(0)
  })

  it('rejects stale writes and leaves the first valid update as the only saved value', async () => {
    const editor = await actor(); const current = await fixture(editor)
    await withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: edit(current.page.id, current.set.id, 'First winner') }))
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: edit(current.page.id, current.set.id, 'Stale loser') }))).rejects.toThrow('STALE_DIRECT_EDIT')
    const page = await payload.findByID({ collection: 'pages', id: current.page.id, draft: true, overrideAccess: true })
    expect((page.blocks as { heading: string }[])[0]?.heading).toBe('First winner')
  })

  it('replays a concurrent duplicate that uses the same field baseline and intended value', async () => {
    const editor = await actor(); const current = await fixture(editor)
    const outcomes = await Promise.allSettled([
      executeDirectEdit({ payload, actor: editor as never, edit: edit(current.page.id, current.set.id, 'Concurrent winner') }),
      executeDirectEdit({ payload, actor: editor as never, edit: edit(current.page.id, current.set.id, 'Concurrent winner') }),
    ])
    if (outcomes.some((outcome) => outcome.status === 'rejected')) throw (outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')!.reason)
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(2)
    expect(outcomes.map((outcome) => outcome.status === 'fulfilled' ? outcome.value.replayed : false)).toContain(true)
    const page = await payload.findByID({ collection: 'pages', id: current.page.id, draft: true, overrideAccess: true })
    expect((page.blocks as { heading: string }[])[0]?.heading).toBe('Concurrent winner')
  })

  it('does not call an unrecorded same value a replay, and re-applies intent after a change away and back', async () => {
    const editor = await actor(); const current = await fixture(editor)
    const empty = await payload.create({ collection: 'change-sets', data: { name: 'Empty direct edit set', state: 'open', actor: editor.id, revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: { ...edit(current.page.id, empty.id, 'Original heading'), expectedValueHash: directEditValueHash('wrong hash') } }))).rejects.toThrow('STALE_DIRECT_EDIT')
    const noOp = await withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: { ...edit(current.page.id, empty.id, 'Original heading'), expectedValueHash: directEditValueHash('Original heading') } }))
    expect(noOp).toMatchObject({ replayed: false, noOp: true })
    await withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: edit(current.page.id, current.set.id, 'Changed away') }))
    await withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: { ...edit(current.page.id, current.set.id, 'Original heading'), expectedValueHash: directEditValueHash('Changed away') } }))
    const reapplied = await withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: edit(current.page.id, current.set.id, 'Changed away') }))
    expect(reapplied).toMatchObject({ replayed: false, noOp: false })
  })

  it('enforces roles, same-origin route auth, set ownership, editable state, field allowlist, and contract validation', async () => {
    const editor = await actor(); const other = await actor('owner'); const approver = await actor('approver'); const current = await fixture(editor)
    const deniedOrigin = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(edit(current.page.id, current.set.id)) }))
    expect(deniedOrigin.status).toBe(403)
    const unauthenticated = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', 'content-type': 'application/json' }, body: JSON.stringify(edit(current.page.id, current.set.id)) }))
    expect(unauthenticated.status).toBe(401)
    const tooLarge = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(5_000) }) }))
    expect(tooLarge.status).toBe(413)
    const cookie = await session(approver)
    const deniedRole = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', cookie, 'content-type': 'application/json' }, body: JSON.stringify(edit(current.page.id, current.set.id)) }))
    expect(deniedRole.status).toBe(403)
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: other as never, edit: edit(current.page.id, current.set.id) }))).rejects.toThrow('CHANGE_SET_NOT_EDITABLE')
    await payload.update({ collection: 'change-sets', id: current.set.id, data: { state: 'submitted' }, overrideAccess: true, context: { editorialInternal: true } })
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: edit(current.page.id, current.set.id) }))).rejects.toThrow('CHANGE_SET_NOT_EDITABLE')
    await payload.update({ collection: 'change-sets', id: current.set.id, data: { state: 'changes-requested' }, overrideAccess: true, context: { editorialInternal: true } })
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: edit(current.page.id, current.set.id, 'Requested revision') }))).resolves.toMatchObject({ replayed: false })
    const requestedHash = directEditValueHash('Requested revision')
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: { ...edit(current.page.id, current.set.id), expectedValueHash: requestedHash, field: 'heading', value: 'x'.repeat(121) } }))).rejects.toThrow('INVALID_DIRECT_EDIT')
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: { ...edit(current.page.id, current.set.id), expectedValueHash: requestedHash, field: 'cta' as never } }))).rejects.toThrow('INVALID_DIRECT_EDIT')
  })
})
