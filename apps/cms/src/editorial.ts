import { createHash, randomUUID } from 'node:crypto'
import type { Payload, PayloadRequest } from 'payload'
import { PageSchema, RedirectSchema, SectionSchema } from '@site-engine/contract'
import { hasRole } from './access'

export type CapturedCollection = 'pages' | 'sections' | 'redirects'
export type ChangeSetState = 'open' | 'submitted' | 'changes-requested' | 'approved' | 'rejected' | 'published' | 'discarded' | 'stale'

type Actor = { id: string; roles?: ('owner' | 'approver' | 'editor' | 'sales' | 'hiring')[] | null; disabled?: boolean | null }
type CapturedChange = {
  collection: CapturedCollection
  id: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  beforeHash: string | null
  afterHash: string | null
}

const mutableFields: Record<CapturedCollection, readonly string[]> = {
  pages: ['title', 'slug', 'sectionId', 'parentId', 'summary', 'template', 'blocks', 'seoDescription'],
  sections: ['name', 'summary', 'slug', 'allowedTemplates', 'pageIds'],
  redirects: ['from', 'to', 'status'],
}

function idOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') return value.id
  return undefined
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: Record<string, unknown> | null): string | null {
  return value === null ? null : createHash('sha256').update(stable(value)).digest('hex')
}

export function snapshot(collection: CapturedCollection, document: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!document) return null
  return Object.fromEntries(mutableFields[collection].flatMap((field) => {
    const value = document[field]
    if (value === undefined) return []
    if (field === 'sectionId' || field === 'parentId') return [[field, idOf(value) ?? null]]
    if (field === 'pageIds' && Array.isArray(value)) return [[field, value.map((item) => idOf(item) ?? item)]]
    return [[field, value]]
  }))
}

function equivalent(left: Record<string, unknown> | null, right: Record<string, unknown> | null): boolean {
  return stable(left) === stable(right)
}

function setIDFromRequest(req: PayloadRequest): string | undefined {
  const candidate = req.headers.get('x-site-engine-change-set')
  return candidate && /^[0-9a-f-]{36}$/i.test(candidate) ? candidate : undefined
}

async function openSet(payload: Payload, actor: Actor, req: PayloadRequest): Promise<Record<string, unknown>> {
  const requested = setIDFromRequest(req)
  if (requested) {
    const selected = await payload.findByID({ collection: 'change-sets', id: requested, depth: 0, overrideAccess: true, req }) as unknown as Record<string, unknown>
    if (selected.state !== 'open' || idOf(selected.actor) !== actor.id) throw new Error('The selected change set is not an open set owned by this editor.')
    return selected
  }
  const existing = await payload.find({ collection: 'change-sets', where: { and: [{ actor: { equals: actor.id } }, { state: { equals: 'open' } }] }, limit: 1, depth: 0, overrideAccess: true, req })
  if (existing.docs[0]) return existing.docs[0] as unknown as Record<string, unknown>
  return payload.create({ collection: 'change-sets', data: { id: randomUUID(), name: 'Unsubmitted edits', state: 'open', actor: actor.id, revision: 0, changes: [] }, overrideAccess: true, req, context: { editorialInternal: true } }) as unknown as Promise<Record<string, unknown>>
}

/** Called by collection hooks after a draft write. The hook request is reused so
 * content, change set, and audit event commit or roll back together. */
export async function captureChange(input: { collection: CapturedCollection; doc: Record<string, unknown>; previousDoc?: Record<string, unknown>; operation: 'create' | 'update'; req: PayloadRequest }): Promise<void> {
  const { collection, doc, previousDoc, operation, req } = input
  const actor = req.user as Actor | undefined
  if (!actor || !hasRole(actor, ['owner', 'editor']) || req.context.editorialInternal) return
  const after = snapshot(collection, doc)
  const before = operation === 'create' ? null : snapshot(collection, previousDoc)
  if (equivalent(before, after)) return
  const changeSet = await openSet(req.payload, actor, req)
  const changes = Array.isArray(changeSet.changes) ? [...changeSet.changes] as CapturedChange[] : []
  const index = changes.findIndex((change) => change.collection === collection && change.id === doc.id)
  const change: CapturedChange = { collection, id: String(doc.id), before, after, beforeHash: hash(before), afterHash: hash(after) }
  if (index >= 0) {
    // Preserve the original baseline while replacing the latest after-image.
    change.before = changes[index].before
    change.beforeHash = changes[index].beforeHash
    if (equivalent(change.before, change.after)) changes.splice(index, 1)
    else changes[index] = change
  } else changes.push(change)
  await req.payload.update({ collection: 'change-sets', id: String(changeSet.id), data: { changes, revision: Number(changeSet.revision ?? 0) + 1 }, overrideAccess: true, req, context: { editorialInternal: true } })
  await req.payload.create({ collection: 'audit-events', data: { event: 'editorial.change_captured', user: actor.id, actor: actor.id, detail: { changeSet: changeSet.id, collection, id: doc.id } }, overrideAccess: true, req })
}

function assertActor(actor: Actor | undefined): asserts actor is Actor {
  if (!actor || actor.disabled) throw new Error('Authentication is required.')
}

async function loadSet(payload: Payload, id: string, req: PayloadRequest): Promise<Record<string, unknown>> {
  return payload.findByID({ collection: 'change-sets', id, depth: 0, overrideAccess: true, req }) as unknown as Promise<Record<string, unknown>>
}

function currentChange(collection: CapturedCollection, value: Record<string, unknown> | undefined): Record<string, unknown> | null {
  return snapshot(collection, value)
}

export async function markStaleIfNeeded(payload: Payload, set: Record<string, unknown>, req: PayloadRequest): Promise<Record<string, unknown>> {
  if (!['open', 'submitted', 'changes-requested'].includes(String(set.state))) return set
  const expired = Date.now() - new Date(String(set.createdAt)).getTime() > 30 * 24 * 60 * 60 * 1000
  const changes = Array.isArray(set.changes) ? set.changes as CapturedChange[] : []
  let changed = expired
  if (!expired) for (const change of changes) {
    if (!change.afterHash) continue
    try {
      const doc = await payload.findByID({ collection: change.collection, id: change.id, depth: 0, draft: true, overrideAccess: true, req }) as unknown as Record<string, unknown>
      if (hash(currentChange(change.collection, doc)) !== change.afterHash) { changed = true; break }
    } catch { changed = true; break }
  }
  if (!changed) return set
  return payload.update({ collection: 'change-sets', id: String(set.id), data: { state: 'stale', staleAt: new Date().toISOString() }, overrideAccess: true, req, context: { editorialInternal: true } }) as unknown as Promise<Record<string, unknown>>
}

function quality(changes: CapturedChange[]) {
  const errors: { collection: string; id: string; message: string }[] = []
  for (const change of changes) {
    if (!change.after) continue
    const result = change.collection === 'pages'
      ? PageSchema.safeParse({ id: change.id, ...change.after, status: 'draft' })
      : change.collection === 'sections'
        ? SectionSchema.safeParse({ id: change.id, ...change.after, pageIds: change.after.pageIds ?? [] })
        : RedirectSchema.safeParse(change.after)
    if (!result.success) errors.push(...result.error.issues.map((issue) => ({ collection: change.collection, id: change.id, message: `${issue.path.join('.')}: ${issue.message}` })))
  }
  return { checks: [{ name: 'contract', status: errors.length ? 'failed' : 'passed', errors }], warnings: ['Preview generation is pending until the preview workflow is installed.'] }
}

export async function transitionChangeSet(input: { payload: Payload; req: PayloadRequest; actor: Actor | undefined; id: string; action: 'submit' | 'request-changes' | 'reject' | 'discard' | 'refresh' }): Promise<Record<string, unknown>> {
  const { payload, req, id, action } = input; assertActor(input.actor)
  let set = await markStaleIfNeeded(payload, await loadSet(payload, id, req), req)
  if (set.state === 'stale') throw new Error('This change set is stale. Refresh it before review.')
  const owns = idOf(set.actor) === input.actor.id
  const reviewer = hasRole(input.actor, ['owner', 'approver'])
  if ((action === 'submit' || action === 'discard' || action === 'refresh') && !owns) throw new Error('Only the editor who owns this change set can perform this action.')
  if ((action === 'request-changes' || action === 'reject') && !reviewer) throw new Error('Reviewer role required.')
  const expected: Record<typeof action, ChangeSetState[]> = { submit: ['open', 'changes-requested'], 'request-changes': ['submitted'], reject: ['submitted'], discard: ['open', 'changes-requested', 'rejected'], refresh: ['open', 'changes-requested'] }
  if (!expected[action].includes(set.state as ChangeSetState)) throw new Error(`Cannot ${action} a ${String(set.state)} change set.`)
  const changes = Array.isArray(set.changes) ? set.changes as CapturedChange[] : []
  const details = action === 'submit' ? quality(changes) : undefined
  if (details?.checks.some((check) => check.status === 'failed')) throw new Error('Change-set quality checks failed.')
  const state: ChangeSetState = action === 'submit' ? 'submitted' : action === 'request-changes' ? 'changes-requested' : action === 'reject' ? 'rejected' : action === 'discard' ? 'discarded' : 'open'
  set = await payload.update({ collection: 'change-sets', id, data: { state, revision: Number(set.revision ?? 0) + 1, quality: details, submittedAt: action === 'submit' ? new Date().toISOString() : typeof set.submittedAt === 'string' ? set.submittedAt : undefined, reviewedAt: ['request-changes', 'reject'].includes(action) ? new Date().toISOString() : typeof set.reviewedAt === 'string' ? set.reviewedAt : undefined }, overrideAccess: true, req, context: { editorialInternal: true } }) as unknown as Record<string, unknown>
  await payload.create({ collection: 'audit-events', data: { event: `editorial.change_set_${action}`, user: input.actor.id, actor: input.actor.id, detail: { changeSet: id, state } }, overrideAccess: true, req })
  return { ...set, preview: action === 'submit' ? { status: 'pending', reason: 'Preview generation is not installed.' } : undefined }
}

export async function createNamedChangeSet(payload: Payload, req: PayloadRequest, actor: Actor | undefined, name: string): Promise<Record<string, unknown>> {
  assertActor(actor)
  if (!hasRole(actor, ['owner', 'editor'])) throw new Error('Editor role required.')
  return payload.create({ collection: 'change-sets', data: { id: randomUUID(), name, actor: actor.id, state: 'open', revision: 0, changes: [] }, overrideAccess: true, req, context: { editorialInternal: true } }) as unknown as Promise<Record<string, unknown>>
}
