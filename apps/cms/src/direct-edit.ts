import { createHash } from 'node:crypto'
import type { Payload, PayloadRequest } from 'payload'
import { PageSchema } from '@site-engine/contract'
import { hasRole } from './access'
import { withPayloadTransaction } from './auth-transaction'
import { directEditDefinitionForPage, validDirectEditValue, type DirectEditField } from './direct-edit-fields'

type Actor = { id: string; roles?: ('owner' | 'approver' | 'editor' | 'sales' | 'hiring')[] | null; disabled?: boolean | null }
type Page = Record<string, unknown>

export type DirectEditInput = {
  pageID: string
  blockID: string
  field: DirectEditField
  value: string
  expectedValueHash: string
  expectedRevision: number
  changeSetID: string
}

export type DirectEditResult = { pageID: string; changeSetID: string; replayed: boolean; noOp: boolean }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha256 = /^[a-f0-9]{64}$/i
const localWriteTails = new WeakMap<Payload, Map<string, Promise<void>>>()

export function directEditValueHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function relationID(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') return (value as { id: string }).id
  return undefined
}

function editableSet(set: Record<string, unknown>, actor: Actor, id: string): void {
  if (String(set.id) !== id || relationID(set.actor) !== actor.id || !['open', 'changes-requested'].includes(String(set.state))) throw new Error('CHANGE_SET_NOT_EDITABLE')
}

function pageForContract(page: Page, blocks: unknown[]): Record<string, unknown> {
  return {
    id: String(page.id), sectionId: relationID(page.sectionId), parentId: relationID(page.parentId),
    title: page.title, summary: page.summary, slug: page.slug, template: page.template,
    status: page.status === 'archived' ? 'archived' : 'draft', blocks,
    kicker: page.kicker ?? undefined, lede: page.lede ?? undefined,
    seoDescription: typeof page.seoDescription === 'string' && page.seoDescription.trim() ? page.seoDescription : undefined,
    noindex: page.noindex === true, publishedAt: page.publishedAt ?? undefined,
    lastReviewed: page.lastReviewed ?? undefined, jobPosting: page.jobPosting ?? undefined,
    businessCase: page.businessCase ?? undefined,
  }
}

function capturedFieldValue(change: unknown, image: 'before' | 'after', blockID: string, field: DirectEditInput['field']): string | undefined {
  if (!change || typeof change !== 'object') return undefined
  const page = (change as Record<string, unknown>)[image]
  if (!page || typeof page !== 'object' || !Array.isArray((page as Record<string, unknown>).blocks)) return undefined
  const block = (page as { blocks: unknown[] }).blocks.find((candidate) => candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).id === blockID) as Record<string, unknown> | undefined
  return typeof block?.[field] === 'string' ? block[field] : undefined
}

function hasCapturedReplay(set: Record<string, unknown>, edit: DirectEditInput): boolean {
  if (!Array.isArray(set.changes)) return false
  return set.changes.some((change) => {
    if (!change || typeof change !== 'object') return false
    const item = change as Record<string, unknown>
    const before = capturedFieldValue(item, 'before', edit.blockID, edit.field)
    return item.collection === 'pages' && item.id === edit.pageID && typeof before === 'string' && directEditValueHash(before) === edit.expectedValueHash && capturedFieldValue(item, 'after', edit.blockID, edit.field) === edit.value
  })
}

/** Applies the bounded direct-edit surface: explicitly mapped, top-level plain-text fields only.
 * The normal Pages hook performs the durable change-set capture in this same
 * transaction; this service deliberately does not create review or publish work. */
export async function applyDirectEdit(input: { payload: Payload; req: PayloadRequest; actor: Actor; edit: DirectEditInput }): Promise<DirectEditResult> {
  const { payload, req, actor, edit } = input
  if (!hasRole(actor, ['owner', 'approver', 'editor'])) throw new Error('EDITOR_ROLE_REQUIRED')
  if (!uuid.test(edit.pageID) || !uuid.test(edit.blockID) || !uuid.test(edit.changeSetID) || !sha256.test(edit.expectedValueHash) || !Number.isSafeInteger(edit.expectedRevision) || edit.expectedRevision < 0 || typeof edit.value !== 'string') throw new Error('INVALID_DIRECT_EDIT')

  req.user = actor as never
  const page = await payload.findByID({ collection: 'pages', id: edit.pageID, depth: 0, draft: true, user: actor as never, overrideAccess: false, req }) as unknown as Page
  // Check the page's real section through its ordinary access rule. This keeps
  // any future section-scoped policy effective for direct edits too.
  const sectionID = relationID(page.sectionId)
  if (!sectionID) throw new Error('SECTION_NOT_ACCESSIBLE')
  await payload.findByID({ collection: 'sections', id: sectionID, depth: 0, draft: true, user: actor as never, overrideAccess: false, req })
  const set = await payload.findByID({ collection: 'change-sets', id: edit.changeSetID, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>
  editableSet(set, actor, edit.changeSetID)

  const blocks = Array.isArray(page.blocks) ? page.blocks.map((block) => ({ ...(block as Record<string, unknown>) })) : []
  const index = blocks.findIndex((block) => block.id === edit.blockID)
  const blockType = String(blocks[index]?.type ?? '')
  if (index < 0 || !directEditDefinitionForPage({ ...page, blocks }, blocks[index]!, edit.field)) throw new Error('FIELD_NOT_EDITABLE')
  if (!validDirectEditValue(blockType, edit.field, edit.value)) throw new Error('INVALID_DIRECT_EDIT')
  const previous = blocks[index]?.[edit.field]
  if (typeof previous !== 'string') throw new Error('FIELD_NOT_EDITABLE')
  const currentHash = directEditValueHash(previous)
  const capturedReplay = hasCapturedReplay(set, edit)
  if (Number(set.revision ?? 0) !== edit.expectedRevision) {
    if (capturedReplay && previous === edit.value) return { pageID: edit.pageID, changeSetID: edit.changeSetID, replayed: true, noOp: false }
    throw new Error('STALE_DIRECT_EDIT')
  }
  if (previous === edit.value) {
    if (currentHash === edit.expectedValueHash) return { pageID: edit.pageID, changeSetID: edit.changeSetID, replayed: false, noOp: true }
    if (capturedReplay) return { pageID: edit.pageID, changeSetID: edit.changeSetID, replayed: true, noOp: false }
    throw new Error('STALE_DIRECT_EDIT')
  }
  if (currentHash !== edit.expectedValueHash) throw new Error('STALE_DIRECT_EDIT')

  blocks[index]![edit.field] = edit.value
  const parsed = PageSchema.safeParse(pageForContract(page, blocks))
  if (!parsed.success) throw new Error('INVALID_DIRECT_EDIT')
  req.headers.set('x-site-engine-change-set', edit.changeSetID)
  await payload.update({ collection: 'pages', id: edit.pageID, data: { blocks }, draft: true, user: actor as never, overrideAccess: false, req })
  return { pageID: edit.pageID, changeSetID: edit.changeSetID, replayed: false, noOp: false }
}

/** SQLite can reject a simultaneously opened write transaction before the
 * value comparison runs. Retrying that narrow condition lets the loser observe
 * the committed field and return the normal stale conflict. */
export async function executeDirectEdit(input: { payload: Payload; actor: Actor; edit: DirectEditInput }): Promise<DirectEditResult> {
  let tails = localWriteTails.get(input.payload)
  if (!tails) { tails = new Map(); localWriteTails.set(input.payload, tails) }
  const prior = tails.get(input.edit.pageID)
  let release!: () => void
  const tail = new Promise<void>((resolve) => { release = resolve })
  tails.set(input.edit.pageID, tail)
  await prior
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try { return await withPayloadTransaction(input.payload, req => applyDirectEdit({ ...input, req })) } catch (error) {
        if (!/SQLITE_BUSY|database is locked/i.test(error instanceof Error ? error.message : '') || attempt === 7) throw error
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt))
      }
    }
    throw new Error('DIRECT_EDIT_UNAVAILABLE')
  } finally {
    release()
    if (tails.get(input.edit.pageID) === tail) tails.delete(input.edit.pageID)
  }
}
