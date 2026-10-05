import { createHash, randomUUID } from 'node:crypto'
import type { Payload } from 'payload'
import { TemplateSchema, type Page } from '@site-engine/contract'
import { z } from 'zod'
import { hasRole } from './access'
import { withPayloadTransaction } from './auth-transaction'
import { createNamedChangeSet } from './editorial'

export type PageCreatorActor = {
  id: string
  roles?: ('owner' | 'approver' | 'editor' | 'sales' | 'hiring')[] | null
  disabled?: boolean | null
}

export type PageCreationSection = {
  id: string
  name: string
  slug: string
  allowedTemplates: Page['template'][]
}

export type PageCreationParent = {
  id: string
  title: string
  slug: string
  sectionID: string
  parentID?: string
  template: Page['template']
  depth: number
}

export type PageCreationContext = {
  sections: PageCreationSection[]
  pages: PageCreationParent[]
  templates: Page['template'][]
}

export type PageCreationInput = {
  requestKey: string
  title: string
  summary: string
  slug: string
  sectionID: string
  parentID?: string
  template: Page['template']
}

export type PageCreationResult = {
  pageID: string
  changeSetID: string
  changeSetRevision: number
  replayed: boolean
}

const InputSchema = z.object({
  requestKey: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(24).max(300),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  sectionID: z.string().uuid(),
  parentID: z.string().uuid().optional(),
  template: TemplateSchema,
}).strict()

function relationID(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string')
    return (value as { id: string }).id
  return undefined
}

function assertCreator(actor: PageCreatorActor): void {
  if (!hasRole(actor, ['owner', 'editor'])) throw new Error('EDITOR_ROLE_REQUIRED')
}

export function parsePageCreationInput(value: unknown): PageCreationInput {
  const parsed = InputSchema.safeParse(value)
  if (!parsed.success) throw new Error('INVALID_PAGE_CREATE')
  return {
    ...parsed.data,
    title: parsed.data.title.trim(),
    summary: parsed.data.summary.trim(),
  }
}

function depths(records: Array<{ id: string; parentID?: string }>): Map<string, number> {
  const byID = new Map(records.map((record) => [record.id, record]))
  const result = new Map<string, number>()
  const visit = (id: string, seen = new Set<string>()): number => {
    const saved = result.get(id)
    if (saved) return saved
    const record = byID.get(id)
    if (!record || seen.has(id)) return 4
    seen.add(id)
    const depth = record.parentID ? visit(record.parentID, seen) + 1 : 1
    result.set(id, depth)
    return depth
  }
  for (const record of records) visit(record.id)
  return result
}

export async function pageCreationContext(
  payload: Payload,
  actor: PageCreatorActor,
): Promise<PageCreationContext> {
  assertCreator(actor)
  const [sectionResult, pageResult] = await Promise.all([
    payload.find({
      collection: 'sections',
      limit: 0,
      pagination: false,
      depth: 0,
      draft: true,
      sort: 'name',
      user: actor as never,
      overrideAccess: false,
    }),
    payload.find({
      collection: 'pages',
      limit: 0,
      pagination: false,
      depth: 0,
      draft: true,
      sort: 'title',
      user: actor as never,
      overrideAccess: false,
    }),
  ])
  const basePages = pageResult.docs.map((document) => ({
    id: String(document.id),
    title: String(document.title ?? ''),
    slug: String(document.slug ?? ''),
    sectionID: relationID(document.sectionId) ?? '',
    parentID: relationID(document.parentId),
    template: document.template as Page['template'],
  }))
  const pageDepths = depths(basePages)
  return {
    sections: sectionResult.docs.map((document) => ({
      id: String(document.id),
      name: String(document.name ?? ''),
      slug: String(document.slug ?? ''),
      allowedTemplates: (document.allowedTemplates ?? []) as Page['template'][],
    })),
    pages: basePages.map((page) => ({ ...page, depth: pageDepths.get(page.id) ?? 4 })),
    templates: [...TemplateSchema.options],
  }
}

function initialBlocks(input: PageCreationInput) {
  if (input.template !== 'landing') return []
  return [{
    id: randomUUID(),
    type: 'hero' as const,
    heading: input.title,
    body: input.summary,
    hidden: false,
    appearance: {
      background: 'default' as const,
      width: 'content' as const,
      spacing: 'default' as const,
      motionIntent: 'none' as const,
      logoTone: 'default' as const,
    },
  }]
}

function creationRequestHash(input: PageCreationInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

async function priorResult(
  payload: Payload,
  actor: PageCreatorActor,
  input: PageCreationInput,
): Promise<PageCreationResult | undefined> {
  const sets = await payload.find({
    collection: 'change-sets',
    where: { and: [
      { actor: { equals: actor.id } },
      { creationRequestKey: { equals: input.requestKey } },
    ] } as never,
    limit: 2,
    depth: 0,
    overrideAccess: true,
  })
  const set = sets.docs[0]
  if (!set) return undefined
  if ((set as unknown as { creationRequestHash?: string }).creationRequestHash !== creationRequestHash(input)) throw new Error('REQUEST_KEY_REUSED')
  const captured = Array.isArray(set.changes) && set.changes.some((change) => {
    if (!change || typeof change !== 'object') return false
    const item = change as Record<string, unknown>
    return item.collection === 'pages' && item.id === input.requestKey && item.before === null
  })
  if (!captured) throw new Error('REQUEST_KEY_REUSED')
  await payload.findByID({ collection: 'pages', id: input.requestKey, depth: 0, draft: true, user: actor as never, overrideAccess: false })
  return {
    pageID: input.requestKey,
    changeSetID: String(set.id),
    changeSetRevision: Number(set.revision ?? 0),
    replayed: true,
  }
}

export async function createPageDraft(input: {
  payload: Payload
  actor: PageCreatorActor
  value: unknown
}): Promise<PageCreationResult> {
  const { payload, actor } = input
  assertCreator(actor)
  const value = parsePageCreationInput(input.value)
  const existing = await priorResult(payload, actor, value)
  if (existing) return existing
  try {
    return await withPayloadTransaction(payload, async (req) => {
      req.user = actor as never
      const set = await createNamedChangeSet(payload, req, actor, `Create ${value.title}`)
      await payload.update({
        collection: 'change-sets',
        id: String(set.id),
        data: { creationRequestKey: value.requestKey, creationRequestHash: creationRequestHash(value) } as never,
        overrideAccess: true,
        req,
        context: { editorialInternal: true },
      })
      // The internal set write shares this transaction request. Restore the
      // ordinary editorial hook context before creating the page so its first
      // draft image is captured into the explicitly selected set.
      req.context = { ...req.context, editorialInternal: false }
      req.headers.set('x-site-engine-change-set', String(set.id))
      const page = await payload.create({
        collection: 'pages',
        data: {
          id: value.requestKey,
          title: value.title,
          summary: value.summary,
          slug: value.slug,
          sectionId: value.sectionID,
          ...(value.parentID ? { parentId: value.parentID } : {}),
          template: value.template,
          status: 'draft',
          blocks: initialBlocks(value),
        },
        draft: true,
        user: actor as never,
        overrideAccess: false,
        req,
      })
      const captured = await payload.findByID({
        collection: 'change-sets',
        id: String(set.id),
        depth: 0,
        overrideAccess: true,
        req,
      })
      return {
        pageID: String(page.id),
        changeSetID: String(set.id),
        changeSetRevision: Number(captured.revision ?? 0),
        replayed: false,
      }
    })
  } catch (error) {
    const replay = await priorResult(payload, actor, value)
    if (replay) return replay
    throw error
  }
}
