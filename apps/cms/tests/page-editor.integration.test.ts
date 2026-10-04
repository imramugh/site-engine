import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { getPayload } from 'payload'
import { withPayloadTransaction } from '../src/auth-transaction'
import {
  applyPageEditorSave,
  executePageEditorSave,
  pageEditorHash,
  pageEditorContext,
  pageEditorProjection,
  parsePageEditorDraft,
} from '../src/page-editor'
import {
  cookieName,
  hashOpaqueToken,
  newOpaqueToken,
  SESSION_COOKIE,
} from '../src/identity'
import { BlockSchema, BlockSchemas } from '@site-engine/contract'
import { blockDefault } from '../app/(staff)/content-editor/[id]/page-editor'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-page-editor-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-page-editor'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE = join(directory, 'bootstrap-token')
writeFileSync(
  process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE,
  'test-only-bootstrap-token',
)
const { default: config } = await import('../payload.config.js')
const editorRoute = await import(
  '../app/api/editorial/page-editor/[id]/route.js'
)
let payload: Awaited<ReturnType<typeof getPayload>>

const hero = {
  id: '10000000-0000-4000-8000-000000000001',
  type: 'hero' as const,
  heading: 'Original heading',
  body: 'Original hero body.',
  hidden: false,
  appearance: {
    background: 'default' as const,
    width: 'content' as const,
    spacing: 'default' as const,
    motionIntent: 'none' as const,
    logoTone: 'default' as const,
  },
}
const text = {
  id: '10000000-0000-4000-8000-000000000002',
  type: 'richText' as const,
  body: 'Original supporting copy.',
  hidden: false,
  appearance: hero.appearance,
}

async function actor(role: 'owner' | 'editor' | 'approver' = 'editor') {
  return payload.create({
    collection: 'users',
    data: {
      email: `${role}-${newOpaqueToken()}@example.test`,
      name: role,
      roles: [role],
    },
    overrideAccess: true,
  })
}
async function session(user: { id: string }) {
  const token = newOpaqueToken()
  const now = new Date().toISOString()
  await payload.create({
    collection: 'auth-sessions',
    data: {
      tokenHash: hashOpaqueToken(token),
      user: user.id,
      authenticatedAt: now,
      lastSeenAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    overrideAccess: true,
  })
  return `${cookieName(SESSION_COOKIE)}=${token}`
}
async function fixture(user: { id: string }) {
  const unique = randomUUID().replaceAll('-', '').slice(0, 12)
  const section = await payload.create({
    collection: 'sections',
    data: {
      name: `Section ${unique}`,
      slug: `section-${unique}`,
      allowedTemplates: ['landing', 'standard'],
    },
    overrideAccess: true,
    context: { editorialInternal: true },
  })
  const page = await payload.create({
    collection: 'pages',
    data: {
      title: 'Full page editor fixture',
      summary:
        'A synthetic page with enough summary text for page editor tests.',
      slug: `page-${unique}`,
      sectionId: section.id,
      template: 'landing',
      blocks: [hero, text],
    },
    overrideAccess: true,
    context: { editorialInternal: true },
  })
  const set = await payload.create({
    collection: 'change-sets',
    data: {
      name: 'Full page edit set',
      state: 'open',
      actor: user.id,
      revision: 0,
      changes: [],
    },
    overrideAccess: true,
    context: { editorialInternal: true },
  })
  return { page, set }
}
function save(
  page: Record<string, unknown>,
  set: { id: string; revision?: number | null },
  title = 'Updated page title',
) {
  const current = pageEditorProjection(page)
  return {
    pageID: String(page.id),
    changeSetID: set.id,
    expectedPageHash: pageEditorHash(current),
    expectedChangeSetRevision: Number(set.revision ?? 0),
    draft: {
      ...current,
      title,
      blocks: [
        current.blocks[0]!,
        {
          id: randomUUID(),
          type: 'callout' as const,
          heading: 'Added callout',
          body: 'A validated new block.',
          hidden: false,
          appearance: hero.appearance,
        },
        current.blocks[1]!,
      ],
    },
  }
}

beforeAll(async () => {
  payload = await getPayload({ config })
}, 30_000)
afterAll(async () => {
  await payload?.destroy()
  rmSync(directory, { recursive: true, force: true })
})

describe('ENG-006/ENG-026 full page draft editor', () => {
  it('builds a schema-valid conventional starting shape for every contract block', () => {
    const references = {
      media: [
        {
          id: '20000000-0000-4000-8000-000000000001',
          label: 'Image',
          mimeType: 'image/png',
        },
        {
          id: '20000000-0000-4000-8000-000000000002',
          label: 'Video',
          mimeType: 'video/mp4',
        },
        {
          id: '20000000-0000-4000-8000-000000000003',
          label: 'Captions',
          mimeType: 'text/vtt',
        },
      ],
      pages: [
        { id: '20000000-0000-4000-8000-000000000004', label: 'Service page' },
      ],
    }
    for (const type of Object.keys(BlockSchemas) as Array<
      keyof typeof BlockSchemas
    >) {
      const candidate = blockDefault(type, references)
      expect(candidate, `${type} needs a conventional default`).toBeDefined()
      expect(
        BlockSchema.safeParse(candidate).success,
        `${type} default must satisfy the contract`,
      ).toBe(true)
    }
  })

  it('captures one validated whole-page update and safely replays the same request', async () => {
    const editor = await actor()
    const current = await fixture(editor)
    const input = save(
      current.page as unknown as Record<string, unknown>,
      current.set,
    )
    const result = await withPayloadTransaction(payload, (req) =>
      applyPageEditorSave({
        payload,
        req,
        actor: editor as never,
        save: input,
      }),
    )
    expect(result).toMatchObject({
      replayed: false,
      noOp: false,
      changeSetRevision: 1,
    })
    const replay = await withPayloadTransaction(payload, (req) =>
      applyPageEditorSave({
        payload,
        req,
        actor: editor as never,
        save: input,
      }),
    )
    expect(replay).toMatchObject({
      replayed: true,
      noOp: false,
      changeSetRevision: 1,
    })
    const page = await payload.findByID({
      collection: 'pages',
      id: current.page.id,
      draft: true,
      overrideAccess: true,
    })
    expect(page).toMatchObject({ title: 'Updated page title', status: 'draft' })
    expect(
      (page.blocks as Array<{ type: string }>).map((block) => block.type),
    ).toEqual(['hero', 'callout', 'richText'])
    const set = await payload.findByID({
      collection: 'change-sets',
      id: current.set.id,
      overrideAccess: true,
    })
    expect(set.changes).toEqual([
      expect.objectContaining({ collection: 'pages', id: current.page.id }),
    ])
  })

  it('serializes duplicate and competing writes while rejecting stale page and set revisions', async () => {
    const editor = await actor()
    const duplicate = await fixture(editor)
    const duplicateSave = save(
      duplicate.page as unknown as Record<string, unknown>,
      duplicate.set,
      'Concurrent duplicate',
    )
    const copies = await Promise.all([
      executePageEditorSave({
        payload,
        actor: editor as never,
        save: duplicateSave,
      }),
      executePageEditorSave({
        payload,
        actor: editor as never,
        save: duplicateSave,
      }),
    ])
    expect(copies.some((item) => item.replayed)).toBe(true)

    const competing = await fixture(editor)
    const first = save(
      competing.page as unknown as Record<string, unknown>,
      competing.set,
      'First winner',
    )
    const second = { ...first, draft: { ...first.draft, title: 'Stale loser' } }
    const outcomes = await Promise.allSettled([
      executePageEditorSave({ payload, actor: editor as never, save: first }),
      executePageEditorSave({ payload, actor: editor as never, save: second }),
    ])
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    )
    expect(outcomes.find((item) => item.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: 'STALE_PAGE_EDIT' }),
    })

    const revision = await fixture(editor)
    await payload.update({
      collection: 'change-sets',
      id: revision.set.id,
      data: { revision: 2 },
      overrideAccess: true,
      context: { editorialInternal: true },
    })
    await expect(
      executePageEditorSave({
        payload,
        actor: editor as never,
        save: save(
          revision.page as unknown as Record<string, unknown>,
          revision.set,
        ),
      }),
    ).rejects.toThrow('STALE_CHANGE_SET')
  })

  it('enforces role, ownership, editable state, origin, bounded input and the exact public projection', async () => {
    const editor = await actor()
    const owner = await actor('owner')
    const approver = await actor('approver')
    const current = await fixture(editor)
    const input = save(
      current.page as unknown as Record<string, unknown>,
      current.set,
    )
    expect(() =>
      parsePageEditorDraft({ ...input.draft, status: 'published' }),
    ).toThrow('INVALID_PAGE_EDIT')
    expect(() =>
      parsePageEditorDraft({
        ...input.draft,
        blocks: [{ ...hero, script: '<script>' }],
      }),
    ).toThrow()
    await expect(
      withPayloadTransaction(payload, (req) =>
        applyPageEditorSave({
          payload,
          req,
          actor: owner as never,
          save: input,
        }),
      ),
    ).rejects.toThrow('CHANGE_SET_NOT_EDITABLE')
    await expect(
      withPayloadTransaction(payload, (req) =>
        applyPageEditorSave({
          payload,
          req,
          actor: approver as never,
          save: input,
        }),
      ),
    ).rejects.toThrow('CHANGE_SET_NOT_EDITABLE')

    const approverDraft = await fixture(approver)
    const approverInput = save(
      approverDraft.page as unknown as Record<string, unknown>,
      approverDraft.set,
      'Approver-owned revision',
    )
    await expect(
      withPayloadTransaction(payload, (req) =>
        applyPageEditorSave({
          payload,
          req,
          actor: approver as never,
          save: approverInput,
        }),
      ),
    ).resolves.toMatchObject({ changeSetRevision: 1, noOp: false })
    const approverSectionID =
      typeof approverDraft.page.sectionId === 'string'
        ? approverDraft.page.sectionId
        : approverDraft.page.sectionId.id
    await expect(
      payload.update({
        collection: 'sections',
        id: approverSectionID,
        data: { name: 'Approver must not restructure sections' },
        user: approver,
        overrideAccess: false,
      }),
    ).rejects.toThrow('not allowed')
    await expect(
      payload.create({
        collection: 'pages',
        data: {
          title: 'Approver cannot create a page',
          summary:
            'This otherwise valid page must be denied by canonical create access.',
          slug: `approver-create-${randomUUID().slice(0, 8)}`,
          sectionId: approverDraft.page.sectionId,
          template: 'standard',
          blocks: [],
        },
        user: approver,
        overrideAccess: false,
      }),
    ).rejects.toThrow('not allowed')

    const approverCookie = await session(approver)
    expect(
      (
        await editorRoute.GET(
          new Request('http://cms.test/api/editorial/page-editor/id', {
            headers: { cookie: approverCookie },
          }),
          { params: Promise.resolve({ id: approverDraft.page.id }) },
        )
      ).status,
    ).toBe(200)
    await payload.update({
      collection: 'users',
      id: approver.id,
      data: { disabled: true },
      overrideAccess: true,
    })
    await expect(
      pageEditorContext(
        payload,
        { id: approver.id, roles: ['approver'], disabled: true },
        approverDraft.page.id,
      ),
    ).rejects.toThrow('EDITOR_ROLE_REQUIRED')
    expect(
      (
        await editorRoute.GET(
          new Request('http://cms.test/api/editorial/page-editor/id', {
            headers: { cookie: approverCookie },
          }),
          { params: Promise.resolve({ id: approverDraft.page.id }) },
        )
      ).status,
    ).toBe(401)
    await payload.update({
      collection: 'change-sets',
      id: current.set.id,
      data: { state: 'submitted' },
      overrideAccess: true,
      context: { editorialInternal: true },
    })
    await expect(
      withPayloadTransaction(payload, (req) =>
        applyPageEditorSave({
          payload,
          req,
          actor: editor as never,
          save: input,
        }),
      ),
    ).rejects.toThrow('CHANGE_SET_NOT_EDITABLE')

    const routeFixture = await fixture(editor)
    const { pageID: _pageID, ...routeInput } = save(
      routeFixture.page as unknown as Record<string, unknown>,
      routeFixture.set,
    )
    const cookie = await session(editor)
    const route = (body: unknown, headers: HeadersInit = {}) =>
      editorRoute.POST(
        new Request('http://cms.test/api/editorial/page-editor/id', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: routeFixture.page.id }) },
      )
    expect((await route(routeInput)).status).toBe(403)
    expect(
      (await route(routeInput, { origin: 'http://cms.test' })).status,
    ).toBe(401)
    expect(
      (
        await route(
          { ...routeInput, publish: true },
          { origin: 'http://cms.test', cookie },
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await route(
          {
            ...routeInput,
            draft: { ...routeInput.draft, status: 'published' },
          },
          { origin: 'http://cms.test', cookie },
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await route(
          { padding: 'x'.repeat(2_100_000) },
          { origin: 'http://cms.test', cookie },
        )
      ).status,
    ).toBe(413)
  })
})
