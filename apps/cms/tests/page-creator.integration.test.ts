import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { getPayload } from 'payload'
import type { Page } from '@site-engine/contract'
import {
  createPageDraft,
  pageCreationContext,
  parsePageCreationInput,
} from '../src/page-creator'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'
import { availableParents, slugFromTitle } from '../app/(staff)/content-editor/new/new-page'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-page-create-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-page-creation'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE = join(directory, 'bootstrap-token')
writeFileSync(process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE, 'test-only-bootstrap-token')
const { default: config } = await import('../payload.config.js')
const createRoute = await import('../app/api/editorial/page-editor/create/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>

async function actor(role: 'owner' | 'editor' | 'approver' | 'sales' = 'editor', disabled = false) {
  return payload.create({
    collection: 'users',
    data: { email: `${role}-${newOpaqueToken()}@example.test`, name: role, roles: [role], disabled },
    overrideAccess: true,
  })
}

async function session(user: { id: string }) {
  const token = newOpaqueToken()
  const now = new Date().toISOString()
  await payload.create({
    collection: 'auth-sessions',
    data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    overrideAccess: true,
  })
  return `${cookieName(SESSION_COOKIE)}=${token}`
}

async function section(name: string, templates: readonly Page['template'][] = ['landing', 'standard', 'pillar', 'service']) {
  const suffix = randomUUID().slice(0, 8)
  return payload.create({
    collection: 'sections',
    data: { name: `${name} ${suffix}`, summary: `A synthetic ${name} section used to test page draft creation policies.`, slug: `${name.toLowerCase()}-${suffix}`, allowedTemplates: [...templates] },
    overrideAccess: true,
    context: { editorialInternal: true },
  })
}

const value = (sectionID: string, overrides: Record<string, unknown> = {}) => ({
  requestKey: randomUUID(),
  title: 'New synthetic page',
  summary: 'A synthetic summary long enough for the page creation form and canonical collection policy.',
  slug: `new-page-${randomUUID().slice(0, 8)}`,
  sectionID,
  template: 'standard',
  ...overrides,
})

async function rawPage(sectionID: string, slug: string, parentID?: string, template: Page['template'] = 'standard') {
  return payload.create({
    collection: 'pages',
    data: { title: slug, summary: `A synthetic summary long enough for the existing ${slug} fixture page.`, slug, sectionId: sectionID, ...(parentID ? { parentId: parentID } : {}), template, blocks: [] },
    overrideAccess: true,
    context: { editorialInternal: true },
  })
}

beforeAll(async () => { payload = await getPayload({ config }) }, 30_000)
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

describe('ENG-006/ENG-026 custom new page flow', () => {
  it('creates a private draft and an explicit captured change set, then replays the request without duplicates', async () => {
    const editor = await actor('editor')
    const area = await section('Create')
    const original = await rawPage(area.id, 'existing-page')
    const input = value(area.id, { template: 'landing', title: 'Landing draft' })
    const first = await createPageDraft({ payload, actor: editor as never, value: input })
    expect(first).toMatchObject({ pageID: input.requestKey, replayed: false, changeSetRevision: 1 })
    const page = await payload.findByID({ collection: 'pages', id: first.pageID, depth: 0, draft: true, overrideAccess: true })
    expect(page).toMatchObject({ title: 'Landing draft', status: 'draft', _status: 'draft', template: 'landing' })
    expect(page.blocks).toEqual([expect.objectContaining({ type: 'hero', heading: 'Landing draft', body: input.summary })])
    const set = await payload.findByID({ collection: 'change-sets', id: first.changeSetID, depth: 0, overrideAccess: true })
    expect(set).toMatchObject({ actor: editor.id, state: 'open', revision: 1, creationRequestKey: input.requestKey, creationRequestHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(set.changes).toEqual([expect.objectContaining({ collection: 'pages', id: first.pageID, before: null })])
    await payload.update({ collection: 'pages', id: first.pageID, data: { title: 'Landing draft edited after creation' }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    const replay = await createPageDraft({ payload, actor: editor as never, value: input })
    expect(replay).toEqual({ ...first, replayed: true })
    await payload.update({ collection: 'change-sets', id: first.changeSetID, data: { creationRequestHash: '0'.repeat(64) } as never, overrideAccess: true, context: { editorialInternal: true } })
    await expect(payload.findByID({ collection: 'change-sets', id: first.changeSetID, depth: 0, overrideAccess: true })).resolves.toMatchObject({ creationRequestHash: set.creationRequestHash })
    expect((await payload.find({ collection: 'pages', where: { id: { equals: input.requestKey } }, depth: 0, draft: true, overrideAccess: true })).totalDocs).toBe(1)
    expect((await payload.findByID({ collection: 'pages', id: original.id, depth: 0, draft: true, overrideAccess: true })).summary).toBe(original.summary)
    await expect(createPageDraft({ payload, actor: editor as never, value: { ...input, title: 'Conflicting retry' } })).rejects.toThrow('REQUEST_KEY_REUSED')
  })

  it('uses the canonical section, parent, depth, service, and sibling-slug policies and rolls back orphan sets', async () => {
    const owner = await actor('owner')
    const first = await section('Policies')
    const second = await section('Elsewhere', ['standard'])
    const pillar = await rawPage(first.id, 'pillar', undefined, 'pillar')
    const root = await rawPage(first.id, 'root')
    const levelTwo = await rawPage(first.id, 'level-two', root.id)
    const levelThree = await rawPage(first.id, 'level-three', levelTwo.id)
    await rawPage(first.id, 'duplicate')
    const beforeSets = (await payload.find({ collection: 'change-sets', limit: 0, pagination: false, overrideAccess: true })).totalDocs
    const rejected = [
      value(first.id, { template: 'article' }),
      value(first.id, { template: 'service' }),
      value(second.id, { parentID: pillar.id }),
      value(first.id, { parentID: levelThree.id }),
      value(first.id, { slug: 'duplicate' }),
    ]
    for (const candidate of rejected)
      await expect(createPageDraft({ payload, actor: owner as never, value: candidate })).rejects.toThrow()
    const afterSets = (await payload.find({ collection: 'change-sets', limit: 0, pagination: false, overrideAccess: true })).totalDocs
    expect(afterSets).toBe(beforeSets)
    await expect(createPageDraft({ payload, actor: owner as never, value: value(first.id, { template: 'service', parentID: pillar.id }) })).resolves.toMatchObject({ replayed: false })
  })

  it('enforces creator roles and returns the complete accessible section and page reference context', async () => {
    const editor = await actor('editor')
    const approver = await actor('approver')
    const disabled = await actor('editor', true)
    const area = await section('Context', ['standard', 'pillar', 'service'])
    for (let index = 0; index < 105; index += 1) await rawPage(area.id, `context-${index}`)
    const context = await pageCreationContext(payload, editor as never)
    expect(context.pages.filter((page) => page.sectionID === area.id)).toHaveLength(105)
    expect(context.sections.find((item) => item.id === area.id)?.allowedTemplates).toEqual(['standard', 'pillar', 'service'])
    await expect(createPageDraft({ payload, actor: approver as never, value: value(area.id) })).rejects.toThrow('EDITOR_ROLE_REQUIRED')
    await expect(createPageDraft({ payload, actor: disabled as never, value: value(area.id) })).rejects.toThrow('EDITOR_ROLE_REQUIRED')
  }, 30_000)

  it('bounds and authenticates the same-origin POST and returns deterministic create/replay responses', async () => {
    const editor = await actor('editor')
    const approver = await actor('approver')
    const area = await section('Route', ['standard'])
    const input = value(area.id)
    const request = (body: unknown, headers: Record<string, string> = {}) => createRoute.POST(new Request('http://cms.test/api/editorial/page-editor/create', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))
    expect((await request(input)).status).toBe(403)
    expect((await request(input, { origin: 'http://cms.test' })).status).toBe(401)
    expect((await request({ ...input, extra: true }, { origin: 'http://cms.test', cookie: await session(editor) })).status).toBe(400)
    expect((await request({ padding: 'x'.repeat(17_000) }, { origin: 'http://cms.test', cookie: await session(editor) })).status).toBe(413)
    expect((await request(input, { origin: 'http://cms.test', cookie: await session(approver) })).status).toBe(403)
    const cookie = await session(editor)
    const created = await request(input, { origin: 'http://cms.test', cookie })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ pageID: input.requestKey, replayed: false })
    const replay = await request(input, { origin: 'http://cms.test', cookie })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ pageID: input.requestKey, replayed: true })
  })

  it('keeps client choices aligned with canonical template parents and generates bounded slugs', () => {
    expect(slugFromTitle('  Création & Delivery: A Page  ')).toBe('creation-delivery-a-page')
    expect(() => parsePageCreationInput({ ...value(randomUUID()), extra: true })).toThrow('INVALID_PAGE_CREATE')
    const pages = [
      { id: randomUUID(), title: 'Pillar', slug: 'pillar', sectionID: 'one', template: 'pillar' as const, depth: 1 },
      { id: randomUUID(), title: 'Standard', slug: 'standard', sectionID: 'one', template: 'standard' as const, depth: 2 },
      { id: randomUUID(), title: 'Deep pillar', slug: 'deep', sectionID: 'one', template: 'pillar' as const, depth: 3 },
      { id: randomUUID(), title: 'Other', slug: 'other', sectionID: 'two', template: 'pillar' as const, depth: 1 },
    ]
    expect(availableParents(pages, 'one', 'service').map((page) => page.title)).toEqual(['Pillar'])
    expect(availableParents(pages, 'one', 'standard').map((page) => page.title)).toEqual(['Pillar', 'Standard'])
  })
})
