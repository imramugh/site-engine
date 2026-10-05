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
const contextRoute = await import('../app/api/editorial/direct-edit/context/route.js')
const styleRoute = await import('../app/api/editorial/direct-edit/style/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>
let releaseSequence = 10_000

const heroID = '10000000-0000-4000-8000-000000000001'
const calloutID = '10000000-0000-4000-8000-000000000002'
const richTextID = '10000000-0000-4000-8000-000000000003'
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
  const section = await payload.create({ collection: 'sections', data: { name: `Section ${unique}`, slug: `section-${unique}`, allowedTemplates: ['landing', 'standard', 'pillar', 'service'] }, overrideAccess: true, context: { editorialInternal: true } })
  const appearance = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' }
  const page = await payload.create({ collection: 'pages', data: { title: 'Direct edit page', summary: 'A synthetic page with enough summary text for direct edit tests.', slug: `page-${unique}`, sectionId: section.id, template: 'landing', blocks: [
    { id: heroID, type: 'hero', eyebrow: 'Original eyebrow', heading: 'Original heading', body: 'Original hero body.', cta: { label: 'Generated link', href: '/contact' }, hidden: false, appearance },
    { id: calloutID, type: 'callout', heading: 'Original callout', body: 'Original callout body.', items: ['Nested item must stay protected.'], cta: { label: 'Generated callout link', href: '/contact' }, hidden: false, appearance },
    { id: richTextID, type: 'richText', body: 'Original rich text.', hidden: false, appearance },
  ] }, overrideAccess: true, context: { editorialInternal: true } })
  const set = await payload.create({ collection: 'change-sets', data: { name: 'Direct edit set', state: 'open', actor: user.id, revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
  return { section, page, set }
}
function edit(pageID: string, setID: string, value = 'Updated heading', expectedRevision = 0) { return { pageID, blockID: heroID, field: 'heading' as const, value, expectedValueHash: directEditValueHash('Original heading'), expectedRevision, changeSetID: setID } }
async function installPublishedPointer(user: { id: string }, setID: string, pageID: string) {
  const sequence = releaseSequence++; const manifest = { pageID, heroHeading: 'Original heading' }
  const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: 'a'.repeat(64), changeSet: setID, reviewRevision: 0, changeHash: 'baseline', manifest, themeVersion: 'test-theme', engineVersion: 'test-engine', contractVersion: '1.0.0', approvedBy: user.id, baselineSequence: 0 }, overrideAccess: true, context: { editorialInternal: true } })
  const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: `direct-edit-baseline:${snapshot.id}`, sequence, snapshot: snapshot.id, changeSet: setID, reviewRevision: 0, changeHash: 'baseline', includedChangeKeys: [], status: 'completed', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  const release = await payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence, snapshot: snapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { status: 'healthy' }, artifact: { digest: 'b'.repeat(64), sourceContentHash: snapshot.contentHash, themeVersion: 'test-theme', engineVersion: 'test-engine', contractVersion: '1.0.0', checks: [{ name: 'artifact-integrity', status: 'passed' }] } }, overrideAccess: true, context: { editorialInternal: true } })
  return { snapshot, release, manifest }
}

beforeAll(async () => { payload = await getPayload({ config }) }, 30_000)
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

describe('ENG-026 draft-only direct rendered-text edits', () => {
  it('projects only supported text, serves CSP-compatible authenticated styles, and saves a non-Hero mapped field', async () => {
    const editor = await actor(); const current = await fixture(editor); const cookie = await session(editor)
    const headers = { cookie }
    const context = await contextRoute.GET(new Request('http://cms.test/api/editorial/direct-edit/context', { headers }))
    expect(context.status).toBe(200)
    const result = await context.json() as { pages: Array<{ id: string; blocks: Array<{ id: string; type: string; fields: Record<string, string> }> }> }
    const page = result.pages.find((item) => item.id === current.page.id)
    expect(page?.blocks).toEqual([
      { id: heroID, type: 'hero', fields: { eyebrow: 'Original eyebrow', heading: 'Original heading', body: 'Original hero body.' } },
      { id: calloutID, type: 'callout', fields: { heading: 'Original callout', body: 'Original callout body.' } },
      { id: richTextID, type: 'richText', fields: { body: 'Original rich text.' } },
    ])
    expect(JSON.stringify(result)).not.toContain('Generated link')
    expect(JSON.stringify(result)).not.toContain('Nested item')

    const style = await styleRoute.GET(new Request('http://cms.test/api/editorial/direct-edit/style', { headers }))
    expect(style.status).toBe(200); expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await style.text()).toContain('data-direct-edit-mode')
    expect((await styleRoute.GET(new Request('http://cms.test/api/editorial/direct-edit/style'))).status).toBe(401)

    const calloutEdit = {
      pageID: current.page.id, blockID: calloutID, field: 'body' as const, value: 'Updated callout body.',
      expectedValueHash: directEditValueHash('Original callout body.'), expectedRevision: 0, changeSetID: current.set.id,
    }
    const saved = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', cookie, 'content-type': 'application/json' }, body: JSON.stringify(calloutEdit) }))
    expect(saved.status, await saved.text()).toBe(200)
    const updated = await payload.findByID({ collection: 'pages', id: current.page.id, draft: true, overrideAccess: true })
    expect((updated.blocks as Array<Record<string, unknown>>)[1]).toMatchObject({ heading: 'Original callout', body: 'Updated callout body.', items: ['Nested item must stay protected.'] })
  })

  it('accepts a valid 10,000-character multibyte field within the 65,536-byte route bound', async () => {
    const editor = await actor(); const current = await fixture(editor); const cookie = await session(editor)
    const value = '界'.repeat(10_000)
    const response = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', cookie, 'content-type': 'application/json' }, body: JSON.stringify({ pageID: current.page.id, blockID: richTextID, field: 'body', value, expectedValueHash: directEditValueHash('Original rich text.'), expectedRevision: 0, changeSetID: current.set.id }) }))
    expect(response.status, await response.text()).toBe(200)
    const updated = await payload.findByID({ collection: 'pages', id: current.page.id, draft: true, overrideAccess: true })
    expect((updated.blocks as Array<Record<string, unknown>>)[2]?.body).toBe(value)
  })

  it('rejects a Service Hero owned by metadata when override text is equal or different', async () => {
    const editor = await actor(); const current = await fixture(editor)
    const parent = await payload.create({ collection: 'pages', data: { title: 'Service pillar', summary: 'Synthetic parent for generated Service Hero ownership tests.', slug: `pillar-${randomUUID().slice(0, 8)}`, sectionId: current.section.id, template: 'pillar', blocks: [] }, overrideAccess: true, context: { editorialInternal: true } })
    await payload.update({ collection: 'pages', id: current.page.id, data: { template: 'service', parentId: parent.id, title: 'Original heading', kicker: 'Original eyebrow', lede: 'Original hero body.' }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: edit(current.page.id, current.set.id) }))).rejects.toThrow('FIELD_NOT_EDITABLE')
    await payload.update({ collection: 'pages', id: current.page.id, data: { title: 'Generated different heading', lede: 'Generated different body.' }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: edit(current.page.id, current.set.id) }))).rejects.toThrow('FIELD_NOT_EDITABLE')
    const cookie = await session(editor)
    const response = await contextRoute.GET(new Request('http://cms.test/api/editorial/direct-edit/context', { headers: { cookie } }))
    const context = await response.json() as { pages: Array<{ id: string; blocks: Array<{ type: string }> }> }
    expect(context.pages.find((page) => page.id === current.page.id)?.blocks.map((block) => block.type)).toEqual(['callout', 'richText'])
  })

  it('uses the same working-draft path as ordinary editing, captures an allowed hero field, and replays safely', async () => {
    const editor = await actor(); const current = await fixture(editor)
    const published = await installPublishedPointer(editor, current.set.id, current.page.id)
    await payload.update({ collection: 'pages', id: current.page.id, data: { title: 'Ordinary working draft change' }, draft: true, user: editor, overrideAccess: false })
    const ordinaryDraft = await payload.findByID({ collection: 'pages', id: current.page.id, draft: true, overrideAccess: true })
    expect(ordinaryDraft._status).toBe('draft')
    const currentSet = await payload.findByID({ collection: 'change-sets', id: current.set.id, overrideAccess: true })
    const cookie = await session(editor)
    const intendedEdit = edit(current.page.id, current.set.id, 'Updated heading', Number(currentSet.revision))
    const response = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', cookie, 'content-type': 'application/json' }, body: JSON.stringify(intendedEdit) }))
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ pageID: current.page.id, changeSetID: current.set.id, replayed: false, noOp: false })
    const replay = await withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: intendedEdit }))
    expect(replay).toMatchObject({ replayed: true, noOp: false })
    const page = await payload.findByID({ collection: 'pages', id: current.page.id, draft: true, overrideAccess: true })
    expect((page.blocks as { heading: string }[])[0]?.heading).toBe('Updated heading'); expect(page.status).toBe('draft')
    const set = await payload.findByID({ collection: 'change-sets', id: current.set.id, overrideAccess: true })
    expect(set.state).toBe('open'); expect(set.changes).toEqual(expect.arrayContaining([expect.objectContaining({ collection: 'pages', id: current.page.id })]))
    const release = await payload.findByID({ collection: 'published-releases', id: published.release.id, overrideAccess: true })
    const snapshot = await payload.findByID({ collection: 'publish-snapshots', id: published.snapshot.id, overrideAccess: true })
    expect(release.snapshot).toMatchObject({ id: published.snapshot.id }); expect(snapshot.manifest).toEqual(published.manifest)
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

  it('returns a stale conflict for competing values from one baseline without changing another Hero field', async () => {
    const editor = await actor(); const current = await fixture(editor)
    const outcomes = await Promise.allSettled([
      executeDirectEdit({ payload, actor: editor as never, edit: edit(current.page.id, current.set.id, 'Competing first') }),
      executeDirectEdit({ payload, actor: editor as never, edit: edit(current.page.id, current.set.id, 'Competing second') }),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({ reason: expect.objectContaining({ message: 'STALE_DIRECT_EDIT' }) })
    const page = await payload.findByID({ collection: 'pages', id: current.page.id, draft: true, overrideAccess: true })
    expect(['Competing first', 'Competing second']).toContain((page.blocks as { heading: string }[])[0]?.heading)
    expect((page.blocks as { body: string }[])[0]?.body).toBe('Original hero body.')
  })

  it('rejects a stale change-set revision even when that field value has not changed', async () => {
    const editor = await actor(); const current = await fixture(editor)
    await withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: { ...edit(current.page.id, current.set.id, 'Original hero body.'), field: 'body', expectedValueHash: directEditValueHash('Original hero body.') } }))
    await withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: { ...edit(current.page.id, current.set.id, 'Changed body'), field: 'body', expectedValueHash: directEditValueHash('Original hero body.') } }))
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: edit(current.page.id, current.set.id, 'Heading from stale revision') }))).rejects.toThrow('STALE_DIRECT_EDIT')
  })

  it('does not call an unrecorded same value a replay or revive an intent from a stale revision', async () => {
    const editor = await actor(); const current = await fixture(editor)
    const empty = await payload.create({ collection: 'change-sets', data: { name: 'Empty direct edit set', state: 'open', actor: editor.id, revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: { ...edit(current.page.id, empty.id, 'Original heading'), expectedValueHash: directEditValueHash('wrong hash') } }))).rejects.toThrow('STALE_DIRECT_EDIT')
    const noOp = await withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: { ...edit(current.page.id, empty.id, 'Original heading'), expectedValueHash: directEditValueHash('Original heading') } }))
    expect(noOp).toMatchObject({ replayed: false, noOp: true })
    await withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: edit(current.page.id, current.set.id, 'Changed away') }))
    await withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: { ...edit(current.page.id, current.set.id, 'Original heading', 1), expectedValueHash: directEditValueHash('Changed away') } }))
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: edit(current.page.id, current.set.id, 'Changed away') }))).rejects.toThrow('STALE_DIRECT_EDIT')
    await withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: { ...edit(current.page.id, current.set.id, 'Changed again', 2), expectedValueHash: directEditValueHash('Original heading') } }))
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: { ...edit(current.page.id, current.set.id, 'Changed again', 2), expectedValueHash: directEditValueHash('Original heading') } }))).resolves.toMatchObject({ replayed: true })
  })

  it('enforces roles, same-origin route auth, set ownership, editable state, field allowlist, and contract validation', async () => {
    const editor = await actor(); const other = await actor('owner'); const approver = await actor('approver'); const current = await fixture(editor)
    const deniedOrigin = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(edit(current.page.id, current.set.id)) }))
    expect(deniedOrigin.status).toBe(403)
    const unauthenticated = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', 'content-type': 'application/json' }, body: JSON.stringify(edit(current.page.id, current.set.id)) }))
    expect(unauthenticated.status).toBe(401)
    const tooLarge = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(70_000) }) }))
    expect(tooLarge.status).toBe(413)
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ padding: 'x'.repeat(70_000) }))) }, cancel() { cancelled = true } })
    const cancelledOverflow = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit))
    expect(cancelledOverflow.status).toBe(413); expect(cancelled).toBe(true)
    const cookie = await session(approver)
    const deniedOtherSet = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', cookie, 'content-type': 'application/json' }, body: JSON.stringify(edit(current.page.id, current.set.id)) }))
    expect(deniedOtherSet.status).toBe(403)
    const approverOwned = await fixture(approver)
    const approverEdit = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', cookie, 'content-type': 'application/json' }, body: JSON.stringify(edit(approverOwned.page.id, approverOwned.set.id, 'Approver-owned revision')) }))
    expect(approverEdit.status, await approverEdit.text()).toBe(200)
    const revokedEditor = await actor(); const revokedOwned = await fixture(revokedEditor); const revokedCookie = await session(revokedEditor)
    const revokedSessions = await payload.find({ collection: 'auth-sessions', where: { user: { equals: revokedEditor.id } }, overrideAccess: true, limit: 10 })
    for (const item of revokedSessions.docs) await payload.delete({ collection: 'auth-sessions', id: item.id, overrideAccess: true })
    const revoked = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', cookie: revokedCookie, 'content-type': 'application/json' }, body: JSON.stringify(edit(revokedOwned.page.id, revokedOwned.set.id)) }))
    expect(revoked.status).toBe(401)
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: other as never, edit: edit(current.page.id, current.set.id) }))).rejects.toThrow('CHANGE_SET_NOT_EDITABLE')
    await payload.update({ collection: 'change-sets', id: current.set.id, data: { state: 'submitted' }, overrideAccess: true, context: { editorialInternal: true } })
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: edit(current.page.id, current.set.id) }))).rejects.toThrow('CHANGE_SET_NOT_EDITABLE')
    await payload.update({ collection: 'change-sets', id: current.set.id, data: { state: 'changes-requested' }, overrideAccess: true, context: { editorialInternal: true } })
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: edit(current.page.id, current.set.id, 'Requested revision') }))).resolves.toMatchObject({ replayed: false })
    const requestedHash = directEditValueHash('Requested revision')
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: { ...edit(current.page.id, current.set.id, 'Updated heading', 1), expectedValueHash: requestedHash, field: 'heading', value: 'x'.repeat(121) } }))).rejects.toThrow('INVALID_DIRECT_EDIT')
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: { ...edit(current.page.id, current.set.id, 'Updated heading', 1), expectedValueHash: requestedHash, field: 'cta' as never } }))).rejects.toThrow('FIELD_NOT_EDITABLE')
  })
})
