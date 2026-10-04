import type { Payload } from 'payload'
import { SiteSnapshotSchema } from '@site-engine/contract'
import { deriveRoutes } from '@site-engine/engine'
import { changeSetHash } from './publishing'
import { exactQualityProof } from './review-quality'
import { fieldDiffs } from './field-diffs'

type RecordValue = Record<string, unknown>
type CapturedChange = { collection: string; id: string; before?: unknown; after?: unknown }

export type ReviewBlockChange = {
  id: string
  type: string
  liveType?: string
  proposedType?: string
  liveOccurrence?: number
  proposedOccurrence?: number
  liveTypeCount?: number
  proposedTypeCount?: number
  label: string
  summary: string
  fields: string[]
  details: Array<{ field: string; before: string; after: string }>
}

export type ReviewModeData = {
  id: string
  name: string
  state: string
  revision: number
  previewJobID: string
  path: string
  pageID?: string
  changedBlocks: ReviewBlockChange[]
  pageFields: string[]
  otherChanges: Array<{ collection: string; id: string; fields: string[] }>
  quality?: ReviewQuality
  reviewComments: Array<{ id: string; author: string; body: string; createdAt: string }>
  approvalProof?: Record<string, unknown>
}

export type ReviewPageRoute = { path: string; pageID?: string }

export type ReviewQuality = {
  checks?: Array<{ name: string; status: string; errors?: Array<{ code?: string; path?: string; message: string }> }>
  warnings?: string[]
  proof?: Record<string, unknown> & { report?: { publishable?: boolean; blockers?: Array<{ code: string; path: string; message: string }>; warnings?: Array<{ code: string; path: string; message: string }> } }
}

const relationID = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const records = (value: unknown): RecordValue[] => Array.isArray(value) ? value.filter((item): item is RecordValue => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : []
const changedFields = (before: unknown, after: unknown) => {
  const left = record(before); const right = record(after)
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
}
const labelFor = (block: RecordValue) => {
  for (const key of ['heading', 'title', 'eyebrow', 'label']) if (typeof block[key] === 'string' && block[key]) return String(block[key])
  return typeof block.type === 'string' ? `${block.type.replace(/([a-z])([A-Z])/g, '$1 $2')} block` : 'Content block'
}

const humanValue = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return 'Not set'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) {
    if (!value.length) return 'None'
    if (value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) return value.map(String).join(', ')
    return `${value.length} item${value.length === 1 ? '' : 's'}`
  }
  const object = record(value)
  for (const key of ['heading', 'title', 'name', 'label', 'text', 'body', 'summary', 'slug']) if (typeof object[key] === 'string' && object[key]) return String(object[key])
  const count = Object.keys(object).length
  return `${count} structured field${count === 1 ? '' : 's'}`
}

function blockPositions(manifest: unknown, pageID?: string): Map<string, { type: string; occurrence: number; count: number }> {
  if (!pageID) return new Map()
  const snapshot = SiteSnapshotSchema.parse(manifest)
  const page = snapshot.pages.find((candidate) => candidate.id === pageID)
  const counts = new Map<string, number>()
  const positions = new Map<string, { type: string; occurrence: number; count: number }>()
  const visible = (page?.blocks ?? []).filter((block) => !block.hidden)
  for (const block of visible) counts.set(block.type, (counts.get(block.type) ?? 0) + 1)
  const occurrences = new Map<string, number>()
  for (const block of visible) {
    const occurrence = occurrences.get(block.type) ?? 0
    positions.set(block.id, { type: block.type, occurrence, count: counts.get(block.type)! })
    occurrences.set(block.type, occurrence + 1)
  }
  return positions
}

export function routesForReviewPreview(manifest: unknown, includedChangeKeys: unknown): ReviewPageRoute[] {
  const snapshot = SiteSnapshotSchema.parse(manifest)
  const pageIDs = Array.isArray(includedChangeKeys) ? [...new Set(includedChangeKeys.filter((key): key is string => typeof key === 'string' && key.startsWith('pages:')).map((key) => key.slice('pages:'.length)))] : []
  if (!pageIDs.length) return [{ path: '/' }]
  const routes = deriveRoutes(snapshot).routes
  return pageIDs.map((pageID) => {
    const route = routes.find((candidate) => candidate.page.id === pageID)
    if (!route) throw new Error('A selected review page has no canonical route in this comparison.')
    return { path: route.path, pageID }
  })
}

export function routeForReviewPreview(manifest: unknown, includedChangeKeys: unknown, selection: { pageID?: string; path?: string } = {}): ReviewPageRoute {
  const routes = routesForReviewPreview(manifest, includedChangeKeys)
  const selected = selection.pageID ? routes.find((route) => route.pageID === selection.pageID) : selection.path ? routes.find((route) => route.path === selection.path) : routes[0]
  if (!selected) throw new Error('The selected page is not part of this immutable comparison.')
  return selected
}

export function describeReviewChanges(changes: CapturedChange[], pageID?: string) {
  const pageChange = pageID ? changes.find((change) => change.collection === 'pages' && change.id === pageID) : undefined
  const before = record(pageChange?.before); const after = record(pageChange?.after)
  const beforeBlocks = new Map(records(before.blocks).map((block) => [String(block.id), block]))
  const afterBlocks = new Map(records(after.blocks).map((block) => [String(block.id), block]))
  const changedBlocks: ReviewBlockChange[] = []
  for (const id of new Set([...beforeBlocks.keys(), ...afterBlocks.keys()])) {
    if (!id || id === 'undefined') continue
    const previous = beforeBlocks.get(id); const next = afterBlocks.get(id)
    if (JSON.stringify(previous) === JSON.stringify(next)) continue
    const value = next ?? previous ?? {}
    const fields = changedFields(previous, next).filter((field) => !['id', 'type'].includes(field))
    const summary = !previous ? 'Added to this page' : !next ? 'Removed from this page' : fields.length ? `Changed ${fields.map((field) => field.replace(/([a-z])([A-Z])/g, '$1 $2')).join(', ')}` : 'Content changed'
    const details = fieldDiffs(previous, next, 24)
      .filter(([field]) => !['id', 'type', 'hidden'].includes(field) && !field.startsWith('appearance'))
      .map(([field, left, right]) => ({ field: field.replace(/([a-z])([A-Z])/g, '$1 $2'), before: humanValue(left), after: humanValue(right) }))
    changedBlocks.push({ id, type: typeof value.type === 'string' ? value.type : 'block', label: labelFor(value), summary, fields, details })
  }
  const pageFields = changedFields(before, after).filter((field) => field !== 'blocks')
  const otherChanges = changes.filter((change) => change !== pageChange).map((change) => ({ collection: change.collection, id: change.id, fields: changedFields(change.before, change.after) }))
  return { changedBlocks, pageFields, otherChanges }
}

async function validatedReview(payload: Payload, id: string) {
  const set = await payload.findByID({ collection: 'change-sets', id, depth: 0, overrideAccess: true })
  const preview = set.preview as { status?: unknown; jobID?: unknown; revision?: unknown; changeHash?: unknown; contentHash?: unknown; includedChangeKeys?: unknown; baselineSnapshotID?: unknown; baselineSequence?: unknown; liveManifestHash?: unknown; proposedManifestHash?: unknown } | undefined
  if (!preview || preview.status !== 'ready' || typeof preview.jobID !== 'string') throw new Error('This review does not have a ready comparison.')
  const job = await payload.findByID({ collection: 'preview-render-jobs', id: preview.jobID, depth: 0, overrideAccess: true })
  const changes = Array.isArray(set.changes) ? set.changes as CapturedChange[] : []
  const includedChangeKeys = Array.isArray(job.includedChangeKeys) ? job.includedChangeKeys.filter((value): value is string => typeof value === 'string') : []
  const previewKeys = Array.isArray(preview.includedChangeKeys) ? preview.includedChangeKeys.filter((value): value is string => typeof value === 'string') : []
  if (job.status !== 'completed' || !job.artifactDigest || relationID(job.changeSet) !== String(set.id) || String(job.id) !== preview.jobID || Number(set.revision) !== Number(job.reviewRevision) || Number(preview.revision) !== Number(job.reviewRevision) || preview.changeHash !== job.changeHash || changeSetHash(changes as never[]) !== job.changeHash || JSON.stringify([...includedChangeKeys].sort()) !== JSON.stringify([...previewKeys].sort()) || preview.liveManifestHash !== job.liveManifestHash || preview.proposedManifestHash !== job.proposedManifestHash) throw new Error('This comparison is no longer current.')
  const included = new Set(includedChangeKeys)
  return { set, preview, job, changes: changes.filter((change) => included.has(`${change.collection}:${change.id}`)) }
}

function reviewForRoute(validated: Awaited<ReturnType<typeof validatedReview>>, route: ReviewPageRoute): ReviewModeData {
  const { set, preview, job, changes } = validated
  const described = describeReviewChanges(changes, route.pageID)
  const livePositions = blockPositions(job.liveManifest, route.pageID)
  const proposedPositions = blockPositions(job.proposedManifest, route.pageID)
  described.changedBlocks = described.changedBlocks.map((change) => {
    const live = livePositions.get(change.id); const proposed = proposedPositions.get(change.id)
    return { ...change, liveType: live?.type, proposedType: proposed?.type, liveOccurrence: live?.occurrence, proposedOccurrence: proposed?.occurrence, liveTypeCount: live?.count, proposedTypeCount: proposed?.count }
  })
  const quality = set.quality as ReviewQuality | undefined
  const currentProof = typeof preview.contentHash === 'string' && Array.isArray(preview.includedChangeKeys) && preview.includedChangeKeys.every((value): value is string => typeof value === 'string') && Number.isInteger(preview.baselineSequence) && quality?.proof?.previewJobID === preview.jobID && exactQualityProof(quality, { revision: Number(set.revision), changeHash: String(job.changeHash), contentHash: preview.contentHash, includedChangeKeys: preview.includedChangeKeys, baselineSnapshotID: typeof preview.baselineSnapshotID === 'string' ? preview.baselineSnapshotID : undefined, baselineSequence: Number(preview.baselineSequence) })
  return {
    id: String(set.id), name: String(set.name), state: String(set.state), revision: Number(set.revision), previewJobID: String(preview.jobID),
    path: route.path, pageID: route.pageID, ...described, quality,
    approvalProof: currentProof ? quality?.proof : undefined,
    reviewComments: Array.isArray(set.reviewComments) ? set.reviewComments as ReviewModeData['reviewComments'] : [],
  }
}

export async function loadReviewModePages(payload: Payload, id: string): Promise<ReviewModeData[]> {
  const validated = await validatedReview(payload, id)
  return routesForReviewPreview(validated.job.proposedManifest, validated.job.includedChangeKeys).map((route) => reviewForRoute(validated, route))
}

export async function loadReviewModeData(payload: Payload, id: string, selection: { pageID?: string; path?: string } = {}): Promise<ReviewModeData> {
  const validated = await validatedReview(payload, id)
  return reviewForRoute(validated, routeForReviewPreview(validated.job.proposedManifest, validated.job.includedChangeKeys, selection))
}
