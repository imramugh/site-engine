import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createClient } from '@libsql/client'
import { ConnectionPool } from '@libsql/client/sqlite3'
import { getPayload } from 'payload'
import { withPayloadTransaction } from '../src/auth-transaction'
import { applyDirectEdit, directEditValueHash, executeDirectEdit } from '../src/direct-edit'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-direct-edit-'))
const dbPath = join(directory, 'cms.sqlite')
process.env.DATABASE_URI = `file:${dbPath}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-direct-edit'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE = join(directory, 'bootstrap-token')
writeFileSync(process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE, 'test-only-bootstrap-token')
const { default: config } = await import('../payload.config.js')
const directRoute = await import('../app/api/editorial/direct-edit/route.js')
const { createClient: createCjsClient } = createRequire(import.meta.url)('@libsql/client/sqlite3') as typeof import('@libsql/client/sqlite3')
let payload: Awaited<ReturnType<typeof getPayload>>
let releaseSequence = 10_000

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
async function installPublishedPointer(user: { id: string }, setID: string, pageID: string) {
  const sequence = releaseSequence++; const manifest = { pageID, heroHeading: 'Original heading' }
  const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: 'a'.repeat(64), changeSet: setID, reviewRevision: 0, changeHash: 'baseline', manifest, themeVersion: 'test-theme', engineVersion: 'test-engine', contractVersion: '1.0.0', approvedBy: user.id, baselineSequence: 0 }, overrideAccess: true, context: { editorialInternal: true } })
  const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: `direct-edit-baseline:${snapshot.id}`, sequence, snapshot: snapshot.id, changeSet: setID, reviewRevision: 0, changeHash: 'baseline', includedChangeKeys: [], status: 'completed', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  const release = await payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence, snapshot: snapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { status: 'healthy' }, artifact: { digest: 'b'.repeat(64), sourceContentHash: snapshot.contentHash, themeVersion: 'test-theme', engineVersion: 'test-engine', contractVersion: '1.0.0', checks: [{ name: 'artifact-integrity', status: 'passed' }] } }, overrideAccess: true, context: { editorialInternal: true } })
  return { snapshot, release, manifest }
}

beforeAll(async () => { payload = await getPayload({ config }) }, 30_000)
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

describe('ENG-026 draft-only direct hero edits', () => {
  it('uses the same working-draft path as ordinary editing, captures an allowed hero field, and replays safely', async () => {
    const editor = await actor(); const current = await fixture(editor)
    const published = await installPublishedPointer(editor, current.set.id, current.page.id)
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

  it('reproduces retryable route backpressure under an independent SQLite writer lock', async () => {
    const editor = await actor(); const current = await fixture(editor); const cookie = await session(editor)
    const beforeAudit = await payload.count({ collection: 'audit-events', overrideAccess: true })
    const beforeOutbox = await payload.count({ collection: 'publish-outbox', overrideAccess: true })
    const external = createClient({ url: `file:${dbPath}` })
    const lock = await external.transaction('write')
    let blocked: Response | undefined
    const started = Date.now()
    try {
      await lock.execute({ sql: 'UPDATE pages SET updated_at = updated_at WHERE id = ?', args: [current.page.id] })
      blocked = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', cookie, 'content-type': 'application/json' }, body: JSON.stringify(edit(current.page.id, current.set.id, 'Retry after lock')) }))
    } finally {
      await lock.rollback()
      external.close()
    }
    expect(blocked?.status).toBe(503)
    expect(blocked?.headers.get('Retry-After')).toBe('1')
    await expect(blocked?.json()).resolves.toEqual({ error: 'Saving is temporarily busy. Please retry.' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_000)
    expect(Date.now() - started).toBeLessThan(12_000)
    const unchanged = await payload.findByID({ collection: 'pages', id: current.page.id, draft: true, overrideAccess: true })
    expect((unchanged.blocks as { heading: string }[])[0]?.heading).toBe('Original heading')
    expect((await payload.count({ collection: 'audit-events', overrideAccess: true })).totalDocs).toBe(beforeAudit.totalDocs)
    expect((await payload.count({ collection: 'publish-outbox', overrideAccess: true })).totalDocs).toBe(beforeOutbox.totalDocs)
    const retried = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', cookie, 'content-type': 'application/json' }, body: JSON.stringify(edit(current.page.id, current.set.id, 'Retry after lock')) }))
    expect(retried.status).toBe(200)
  }, 20_000)

  it('replaces only a discarded failed-begin connection while serving its waiter', async () => {
    const pool = new ConnectionPool(dbPath, {}, 2)
    const survivor = await pool.acquire(true)
    // The failed-BEGIN borrower is deliberately not marked as a surviving
    // transaction: it models the connection after `transaction()` has given
    // up ownership, while another transaction remains active.
    const failedBegin = await pool.acquire()
    const waiter = pool.acquire()
    let survivorReleased = false
    let replacement: typeof failedBegin | undefined
    let replacementReleased = false
    try {
      survivor.prepare('BEGIN').run()
      ;(pool as unknown as { discard(database: typeof failedBegin): void }).discard(failedBegin)
      replacement = await waiter
      expect(replacement).not.toBe(failedBegin)
      expect(survivor.open).toBe(true)
      expect(survivor.inTransaction).toBe(true)
      survivor.prepare('CREATE TABLE IF NOT EXISTS pool_survivor (id TEXT PRIMARY KEY)').run()
      const survivorID = randomUUID()
      survivor.prepare('INSERT INTO pool_survivor (id) VALUES (?)').run(survivorID)
      survivor.prepare('COMMIT').run()
      pool.release(survivor)
      survivorReleased = true
      expect(replacement.prepare('SELECT id FROM pool_survivor WHERE id = ?').get(survivorID)).toMatchObject({ id: survivorID })
      pool.release(replacement)
      replacementReleased = true
    } finally {
      if (survivor.open && survivor.inTransaction) survivor.prepare('ROLLBACK').run()
      if (!survivorReleased) pool.release(survivor)
      if (replacement && !replacementReleased) pool.release(replacement)
      pool.close()
    }
  })

  it('keeps timeout and foreign-key enforcement on replacement connections after repeated busy BEGINs', async () => {
    const path = join(directory, `replacement-${randomUUID()}.sqlite`)
    const client = createClient({ url: `file:${path}`, timeout: 5_000, concurrency: 2 })
    const external = createClient({ url: `file:${path}` })
    try {
      await client.execute('PRAGMA foreign_keys = ON')
      await client.execute('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
      await client.execute('CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))')
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const lock = await external.transaction('write')
        await lock.execute('INSERT INTO parent (id) VALUES (?)', [100 + cycle])
        const started = Date.now()
        await expect(client.transaction('write')).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
        expect(Date.now() - started).toBeGreaterThanOrEqual(4_000)
        await lock.rollback()
        expect((await client.execute('PRAGMA foreign_keys')).rows).toEqual([{ foreign_keys: 1 }])
        await expect(client.execute('INSERT INTO child (id, parent_id) VALUES (?, ?)', [cycle + 1, 9_999])).rejects.toThrow(/FOREIGN KEY/)
        const valid = await client.transaction('write')
        await valid.execute('INSERT INTO parent (id) VALUES (?)', [cycle + 1])
        await valid.commit()
      }
    } finally { client.close(); external.close() }
  }, 20_000)

  it('recovers the CJS libSQL transaction client after a busy BEGIN', async () => {
    const editor = await actor(); const current = await fixture(editor)
    const external = createClient({ url: `file:${dbPath}` })
    const cjs = createCjsClient({ url: `file:${dbPath}` })
    const lock = await external.transaction('write')
    try {
      await lock.execute({ sql: 'UPDATE pages SET updated_at = updated_at WHERE id = ?', args: [current.page.id] })
      await expect(cjs.transaction('write')).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
    } finally {
      await lock.rollback()
      external.close()
    }
    const retried = await cjs.transaction('write')
    try {
      await retried.execute({ sql: 'UPDATE pages SET updated_at = updated_at WHERE id = ?', args: [current.page.id] })
      await retried.commit()
    } finally {
      if (!retried.closed) await retried.rollback()
      cjs.close()
    }
  }, 20_000)

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
    await withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: { ...edit(current.page.id, current.set.id, 'Changed again'), expectedValueHash: directEditValueHash('Changed away') } }))
    await expect(withPayloadTransaction(payload, req => applyDirectEdit({ payload, req, actor: editor as never, edit: { ...edit(current.page.id, current.set.id, 'Changed again'), expectedValueHash: directEditValueHash('Changed away') } }))).rejects.toThrow('STALE_DIRECT_EDIT')
  })

  it('enforces roles, same-origin route auth, set ownership, editable state, field allowlist, and contract validation', async () => {
    const editor = await actor(); const other = await actor('owner'); const approver = await actor('approver'); const current = await fixture(editor)
    const deniedOrigin = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(edit(current.page.id, current.set.id)) }))
    expect(deniedOrigin.status).toBe(403)
    const unauthenticated = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', 'content-type': 'application/json' }, body: JSON.stringify(edit(current.page.id, current.set.id)) }))
    expect(unauthenticated.status).toBe(401)
    const tooLarge = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(5_000) }) }))
    expect(tooLarge.status).toBe(413)
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ padding: 'x'.repeat(5_000) }))) }, cancel() { cancelled = true } })
    const cancelledOverflow = await directRoute.POST(new Request('http://cms.test/api/editorial/direct-edit', { method: 'POST', headers: { origin: 'http://cms.test', 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit))
    expect(cancelledOverflow.status).toBe(413); expect(cancelled).toBe(true)
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
