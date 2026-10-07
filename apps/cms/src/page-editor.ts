import type { Payload, PayloadRequest } from 'payload'
import {
  BlockSchema,
  BusinessCaseSchema,
  JobPostingSchema,
  AppearanceOptions,
  PageSchema,
  TemplateAllowedBlocks,
  type Block,
  type Page as ContractPage,
} from '@site-engine/contract'
import { hasRole } from './access'
import { withPayloadTransaction } from './auth-transaction'
import { blockCatalog } from './block-gallery'
import { workingPageState } from './content-readiness'
import { canonicalHash } from './publishing'
import { previewThemeContext, type PreviewBaseline } from './review-preview'
import { snapshot, type CapturedChange } from './editorial'
import { ZodError } from 'zod'

export type PageEditorActor = {
  id: string
  roles?: ('owner' | 'approver' | 'editor' | 'sales' | 'hiring')[] | null
  disabled?: boolean | null
}
export type PageEditorDraft = {
  title: string
  summary: string
  slug: string
  seoDescription?: string
  noindex: boolean
  kicker?: ContractPage['kicker']
  lede?: ContractPage['lede']
  publishedAt?: ContractPage['publishedAt']
  lastReviewed?: ContractPage['lastReviewed']
  jobPosting?: ContractPage['jobPosting']
  businessCase?: ContractPage['businessCase']
  blocks: Block[]
}
export type PageEditorSave = {
  pageID: string
  changeSetID: string
  expectedPageHash: string
  expectedChangeSetRevision: number
  draft: PageEditorDraft
}
export type PageEditorAudit = { user: string; actor: string; detail: Record<string, unknown> }
export type PageEditorSaveResult = {
  pageID: string
  changeSetID: string
  pageHash: string
  changeSetRevision: number
  replayed: boolean
  noOp: boolean
  quality?: unknown
}
export type PageEditorPreflight = {
  pageID: string
  changeSetID: string
  pageHash: string
  changeSetRevision: number
  replayed: boolean
  noOp: boolean
  /** Candidate captures are intentionally returned only to the server route
   * that evaluates readiness; they are never persisted by preflight. */
  changes: CapturedChange[]
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha256 = /^[a-f0-9]{64}$/i
const writeTails = new WeakMap<Payload, Map<string, Promise<void>>>()

function relationID(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string'
  )
    return (value as { id: string }).id
  return undefined
}

function editableSet(
  set: Record<string, unknown>,
  actor: PageEditorActor,
  id: string,
): void {
  if (
    String(set.id) !== id ||
    relationID(set.actor) !== actor.id ||
    !['open', 'changes-requested'].includes(String(set.state))
  )
    throw new Error('CHANGE_SET_NOT_EDITABLE')
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

export function parsePageEditorDraft(value: unknown): PageEditorDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_PAGE_EDIT')
  const draft = value as Record<string, unknown>
  if (
    !exactKeys(draft, [
      'title',
      'summary',
      'slug',
      'seoDescription',
      'noindex',
      'kicker',
      'lede',
      'publishedAt',
      'lastReviewed',
      'jobPosting',
      'businessCase',
      'blocks',
    ]) ||
    typeof draft.title !== 'string' ||
    typeof draft.summary !== 'string' ||
    typeof draft.slug !== 'string' ||
    (draft.seoDescription !== undefined &&
      typeof draft.seoDescription !== 'string') ||
    (draft.kicker !== undefined && typeof draft.kicker !== 'string') ||
    (draft.lede !== undefined && typeof draft.lede !== 'string') ||
    (draft.publishedAt !== undefined && typeof draft.publishedAt !== 'string') ||
    (draft.lastReviewed !== undefined && typeof draft.lastReviewed !== 'string') ||
    typeof draft.noindex !== 'boolean' ||
    !Array.isArray(draft.blocks) ||
    draft.blocks.length > 40
  )
    throw new Error('INVALID_PAGE_EDIT')
  const blocks = draft.blocks.map((block, index) => {
    try {
      return BlockSchema.parse(block)
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ZodError(error.issues.map((issue) => ({ ...issue, path: ['blocks', index, ...issue.path] })))
      }
      throw error
    }
  })
  const seoDescription = draft.seoDescription?.trim()
  const kicker = typeof draft.kicker === 'string' ? draft.kicker.trim() : undefined
  const lede = typeof draft.lede === 'string' ? draft.lede.trim() : undefined
  const publishedAt = typeof draft.publishedAt === 'string' ? draft.publishedAt : undefined
  const lastReviewed = typeof draft.lastReviewed === 'string' ? draft.lastReviewed : undefined
  const jobPosting = draft.jobPosting === undefined ? undefined : JobPostingSchema.parse(draft.jobPosting)
  const businessCase = draft.businessCase === undefined ? undefined : BusinessCaseSchema.parse(draft.businessCase)
  return {
    title: draft.title,
    summary: draft.summary,
    slug: draft.slug,
    ...(seoDescription ? { seoDescription } : {}),
    ...(kicker ? { kicker } : {}),
    ...(lede ? { lede } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(lastReviewed ? { lastReviewed } : {}),
    ...(jobPosting ? { jobPosting } : {}),
    ...(businessCase ? { businessCase } : {}),
    noindex: draft.noindex,
    blocks,
  }
}

/** Strict transport parser shared by save and preflight routes. */
export function parsePageEditorSaveInput(pageID: string, body: Record<string, unknown>): PageEditorSave {
  if (!Object.keys(body).every((key) => ['changeSetID', 'expectedPageHash', 'expectedChangeSetRevision', 'draft'].includes(key)) || typeof body.changeSetID !== 'string' || typeof body.expectedPageHash !== 'string' || !Number.isInteger(body.expectedChangeSetRevision)) throw new Error('INVALID_PAGE_EDIT')
  return {
    pageID,
    changeSetID: body.changeSetID,
    expectedPageHash: body.expectedPageHash,
    expectedChangeSetRevision: body.expectedChangeSetRevision as number,
    draft: parsePageEditorDraft(body.draft),
  }
}

export function pageEditorProjection(
  page: Record<string, unknown>,
): PageEditorDraft {
  return parsePageEditorDraft({
    title: page.title,
    summary: page.summary,
    slug: page.slug,
    ...(typeof page.seoDescription === 'string' && page.seoDescription.trim()
      ? { seoDescription: page.seoDescription }
      : {}),
    ...(typeof page.kicker === 'string' && page.kicker.trim() ? { kicker: page.kicker } : {}),
    ...(typeof page.lede === 'string' && page.lede.trim() ? { lede: page.lede } : {}),
    ...(typeof page.publishedAt === 'string' ? { publishedAt: page.publishedAt } : {}),
    ...(typeof page.lastReviewed === 'string' ? { lastReviewed: page.lastReviewed } : {}),
    ...(page.jobPosting ? { jobPosting: page.jobPosting } : {}),
    ...(page.businessCase ? { businessCase: page.businessCase } : {}),
    noindex: page.noindex === true,
    blocks: Array.isArray(page.blocks) ? page.blocks : [],
  })
}

export const pageEditorHash = (page: PageEditorDraft): string =>
  canonicalHash(page)

function capturedProjection(
  change: unknown,
  image: 'before' | 'after',
): PageEditorDraft | undefined {
  if (!change || typeof change !== 'object') return undefined
  const item = change as Record<string, unknown>
  if (
    item.collection !== 'pages' ||
    !item[image] ||
    typeof item[image] !== 'object'
  )
    return undefined
  try {
    return pageEditorProjection(item[image] as Record<string, unknown>)
  } catch {
    return undefined
  }
}

function replayed(
  set: Record<string, unknown>,
  save: PageEditorSave,
  desiredHash: string,
): boolean {
  if (!Array.isArray(set.changes)) return false
  return set.changes.some((change) => {
    if (
      !change ||
      typeof change !== 'object' ||
      (change as Record<string, unknown>).id !== save.pageID
    )
      return false
    const before = capturedProjection(change, 'before')
    const after = capturedProjection(change, 'after')
    return Boolean(
      before &&
        after &&
        pageEditorHash(before) === save.expectedPageHash &&
        pageEditorHash(after) === desiredHash,
    )
  })
}

function contractPage(
  page: Record<string, unknown>,
  draft: PageEditorDraft,
): ContractPage {
  return PageSchema.parse({
    id: String(page.id),
    sectionId: relationID(page.sectionId),
    parentId: relationID(page.parentId),
    ...draft,
    template: page.template,
    status: 'draft',
  })
}

type PreparedPageEditorSave = {
  desired: PageEditorDraft
  page: Record<string, unknown>
  set: Record<string, unknown>
  current: PageEditorDraft
  currentHash: string
  desiredHash: string
}

async function preparePageEditorSave(input: {
  payload: Payload
  req: PayloadRequest
  actor: PageEditorActor
  save: PageEditorSave
  initialBaseline?: PreviewBaseline
}): Promise<PreparedPageEditorSave> {
  const { payload, req, actor, save } = input
  if (!hasRole(actor, ['owner', 'approver', 'editor'])) throw new Error('EDITOR_ROLE_REQUIRED')
  if (!uuid.test(save.pageID) || !uuid.test(save.changeSetID) || !sha256.test(save.expectedPageHash) || !Number.isInteger(save.expectedChangeSetRevision) || save.expectedChangeSetRevision < 0) throw new Error('INVALID_PAGE_EDIT')
  const desired = parsePageEditorDraft(save.draft)
  req.user = actor as never
  const page = await payload.findByID({ collection: 'pages', id: save.pageID, depth: 0, draft: true, user: actor as never, overrideAccess: false, req }) as unknown as Record<string, unknown>
  const sectionID = relationID(page.sectionId)
  if (!sectionID) throw new Error('SECTION_NOT_ACCESSIBLE')
  await payload.findByID({ collection: 'sections', id: sectionID, depth: 0, draft: true, user: actor as never, overrideAccess: false, req })
  const set = await payload.findByID({ collection: 'change-sets', id: save.changeSetID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>
  editableSet(set, actor, save.changeSetID)
  if (desired.kicker || desired.lede || desired.lastReviewed) {
    const previewContext = await previewThemeContext({ payload, changeSets: [set], initialBaseline: input.initialBaseline, req })
    if (!['1.4.0', '1.5.0', '1.6.0', '1.7.0'].includes(previewContext.changeSetContractVersions[save.changeSetID] ?? '')) throw new Error('PAGE_METADATA_UNSUPPORTED')
  }
  const current = pageEditorProjection(page)
  return { desired, page, set, current, currentHash: pageEditorHash(current), desiredHash: pageEditorHash(desired) }
}

function assertFreshPageEditorSave(prepared: PreparedPageEditorSave, save: PageEditorSave): { replayed: boolean; noOp: boolean } {
  if (prepared.currentHash === prepared.desiredHash) {
    if (prepared.currentHash === save.expectedPageHash) return { replayed: false, noOp: true }
    if (replayed(prepared.set, save, prepared.desiredHash)) return { replayed: true, noOp: false }
  }
  if (prepared.currentHash !== save.expectedPageHash) throw new Error('STALE_PAGE_EDIT')
  if (Number(prepared.set.revision ?? 0) !== save.expectedChangeSetRevision) throw new Error('STALE_CHANGE_SET')
  return { replayed: false, noOp: false }
}

function candidateChanges(set: Record<string, unknown>, page: Record<string, unknown>, desired: PageEditorDraft): CapturedChange[] {
  const current = Array.isArray(set.changes) ? structuredClone(set.changes) as CapturedChange[] : []
  const index = current.findIndex((change) => change.collection === 'pages' && change.id === String(page.id))
  const existing = index >= 0 ? current[index] : undefined
  const after = snapshot('pages', { ...page, ...desired, status: 'draft' })
  const change: CapturedChange = {
    collection: 'pages', id: String(page.id),
    before: existing ? existing.before : snapshot('pages', page), after,
    beforeHash: existing?.beforeHash ?? null, afterHash: null,
    ...(existing?.retainedDraftHash ? { retainedDraftHash: existing.retainedDraftHash } : {}),
  }
  if (index >= 0) current[index] = change
  else current.push(change)
  return current
}

/** Validates the exact full-page save contract and builds an in-memory
 * candidate for readiness checks. It never writes a page or change set. */
export async function validatePageEditorSave(input: {
  payload: Payload
  req: PayloadRequest
  actor: PageEditorActor
  save: PageEditorSave
  initialBaseline?: PreviewBaseline
}): Promise<PageEditorPreflight> {
  const prepared = await preparePageEditorSave(input)
  const freshness = assertFreshPageEditorSave(prepared, input.save)
  contractPage(prepared.page, prepared.desired)
  return {
    pageID: input.save.pageID, changeSetID: input.save.changeSetID,
    pageHash: prepared.desiredHash, changeSetRevision: Number(prepared.set.revision ?? 0),
    ...freshness,
    changes: candidateChanges(prepared.set, prepared.page, prepared.desired),
  }
}

export async function applyPageEditorSave(input: {
  payload: Payload
  req: PayloadRequest
  actor: PageEditorActor
  save: PageEditorSave
  initialBaseline?: PreviewBaseline
  audit?: PageEditorAudit
  evaluateQuality?: (req: PayloadRequest, changeSet: Record<string, unknown>) => Promise<unknown>
}): Promise<PageEditorSaveResult> {
  const { payload, req, save } = input
  const prepared = await preparePageEditorSave(input)
  const { desired, page, set, currentHash, desiredHash } = prepared
  const withQuality = async (result: PageEditorSaveResult, changeSet: Record<string, unknown>) => input.evaluateQuality ? { ...result, quality: await input.evaluateQuality(req, changeSet) } : result
  const freshness = assertFreshPageEditorSave(prepared, save)
  if (freshness.noOp) {
      return withQuality({
        pageID: save.pageID,
        changeSetID: save.changeSetID,
        pageHash: currentHash,
        changeSetRevision: Number(set.revision ?? 0),
        replayed: false,
        noOp: true,
      }, set)
  }
  if (freshness.replayed) {
      return withQuality({
        pageID: save.pageID,
        changeSetID: save.changeSetID,
        pageHash: currentHash,
        changeSetRevision: Number(set.revision ?? 0),
        replayed: true,
        noOp: false,
      }, set)
  }
  contractPage(page, desired)
  req.headers.set('x-site-engine-change-set', save.changeSetID)
  await payload.update({
    collection: 'pages',
    id: save.pageID,
    data: {
      ...desired,
      kicker: desired.kicker ?? null,
      lede: desired.lede ?? null,
      seoDescription: desired.seoDescription ?? null,
      publishedAt: desired.publishedAt ?? null,
      lastReviewed: desired.lastReviewed ?? null,
      jobPosting: desired.jobPosting ?? null,
      businessCase: desired.businessCase ?? null,
      status: 'draft',
    },
    draft: true,
    user: input.actor as never,
    overrideAccess: false,
    req,
  })
  if (input.audit) await payload.create({ collection: 'audit-events', data: { event: 'mcp.tool_result', ...input.audit }, overrideAccess: true, req })
  const updatedSet = await payload.findByID({
    collection: 'change-sets',
    id: save.changeSetID,
    depth: 0,
    overrideAccess: true,
    req,
  })
  return withQuality({
    pageID: save.pageID,
    changeSetID: save.changeSetID,
    pageHash: desiredHash,
    changeSetRevision: Number(updatedSet.revision ?? 0),
    replayed: false,
    noOp: false,
  }, updatedSet as unknown as Record<string, unknown>)
}

export async function executePageEditorSave(input: {
  payload: Payload
  actor: PageEditorActor
  save: PageEditorSave
  initialBaseline?: PreviewBaseline
  audit?: PageEditorAudit
  evaluateQuality?: (req: PayloadRequest, changeSet: Record<string, unknown>) => Promise<unknown>
}): Promise<PageEditorSaveResult> {
  let tails = writeTails.get(input.payload)
  if (!tails) {
    tails = new Map()
    writeTails.set(input.payload, tails)
  }
  const prior = tails.get(input.save.pageID)
  let release!: () => void
  const tail = new Promise<void>((resolve) => {
    release = resolve
  })
  tails.set(input.save.pageID, tail)
  await prior
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await withPayloadTransaction(input.payload, (req) =>
          applyPageEditorSave({ ...input, req }),
        )
      } catch (error) {
        if (
          !/SQLITE_BUSY|database is locked/i.test(
            error instanceof Error ? error.message : '',
          ) ||
          attempt === 7
        )
          throw error
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt))
      }
    }
    throw new Error('PAGE_EDITOR_UNAVAILABLE')
  } finally {
    release()
    if (tails.get(input.save.pageID) === tail) tails.delete(input.save.pageID)
  }
}

export async function pageEditorContext(
  payload: Payload,
  actor: PageEditorActor,
  pageID: string,
  initialBaseline?: PreviewBaseline,
) {
  if (!hasRole(actor, ['owner', 'approver', 'editor']) || !uuid.test(pageID))
    throw new Error('EDITOR_ROLE_REQUIRED')
  const [page, sets, pages, sections, assets] = await Promise.all([
    payload.findByID({
      collection: 'pages',
      id: pageID,
      depth: 0,
      draft: true,
      user: actor as never,
      overrideAccess: false,
    }),
    payload.find({
      collection: 'change-sets',
      where: {
        and: [
          { actor: { equals: actor.id } },
          { state: { in: ['open', 'changes-requested'] } },
        ],
      },
      sort: '-updatedAt',
      limit: 50,
      depth: 0,
      user: actor as never,
      overrideAccess: false,
    }),
    payload.find({
      collection: 'pages',
      limit: 0,
      pagination: false,
      depth: 0,
      draft: true,
      user: actor as never,
      overrideAccess: false,
    }),
    payload.find({
      collection: 'sections',
      limit: 0,
      pagination: false,
      depth: 0,
      draft: true,
      user: actor as never,
      overrideAccess: false,
    }),
    payload.find({
      collection: 'assets',
      limit: 100,
      depth: 0,
      user: actor as never,
      overrideAccess: false,
    }),
  ])
  const pageRecord = page as unknown as Record<string, unknown>
  const sectionID = relationID(pageRecord.sectionId)
  const section = sections.docs.find((item) => item.id === sectionID)
  if (!section) throw new Error('SECTION_NOT_ACCESSIBLE')
  const pageMap = new Map(pages.docs.map((item) => [item.id, item]))
  const ancestors: Array<{ id: string; title: string }> = []
  let parentID = relationID(pageRecord.parentId)
  const visited = new Set<string>()
  while (parentID && !visited.has(parentID) && ancestors.length < 3) {
    visited.add(parentID)
    const parent = pageMap.get(parentID)
    if (!parent) break
    ancestors.unshift({ id: String(parent.id), title: String(parent.title) })
    parentID = relationID(parent.parentId)
  }
  const previewContext = await previewThemeContext({
    payload,
    changeSets: sets.docs as unknown as Array<Record<string, unknown>>,
    initialBaseline,
  })
  const releasedPages = previewContext.liveManifest?.pages ?? []
  const released = releasedPages.find((item) => item.id === pageID)
  const draft = pageEditorProjection(pageRecord)
  const template = pageRecord.template as ContractPage['template']
  return {
    page: {
      id: pageID,
      template,
      state: workingPageState(pageRecord, released),
      draft,
      hash: pageEditorHash(draft),
    },
    breadcrumb: [
      { label: 'Pages', href: '/content-tree' },
      { label: String(section.name), href: '/content-tree' },
      ...ancestors.map((item) => ({
        label: item.title,
        href: `/content-editor/${item.id}`,
      })),
      { label: draft.title },
    ],
    changeSets: sets.docs.map((set) => ({
      id: String(set.id),
      name: String(set.name),
      state: String(set.state),
      revision: Number(set.revision ?? 0),
      changes: Array.isArray(set.changes) ? set.changes.length : 0,
      theme: Object.prototype.hasOwnProperty.call(
        previewContext.changeSetThemes,
        String(set.id),
      )
        ? previewContext.changeSetThemes[String(set.id)]
        : previewContext.activeTheme,
      contractVersion: Object.prototype.hasOwnProperty.call(
        previewContext.changeSetContractVersions,
        String(set.id),
      )
        ? previewContext.changeSetContractVersions[String(set.id)]
        : previewContext.activeContractVersion,
    })),
    blockCatalog: blockCatalog.filter((item) =>
      TemplateAllowedBlocks[template].includes(item.type),
    ),
    appearanceCapabilities: AppearanceOptions,
    activeTheme: previewContext.activeTheme,
    activeContractVersion: previewContext.activeContractVersion,
    references: {
      media: assets.docs.map((asset) => ({
        id: String(asset.id),
        label: String(asset.alt || asset.filename || 'Untitled media'),
        mimeType: String(asset.mimeType || ''),
      })),
      pages: pages.docs
        .filter((item) => item.template === 'service' && item.id !== pageID)
        .map((item) => ({ id: String(item.id), label: String(item.title) })),
    },
  }
}
