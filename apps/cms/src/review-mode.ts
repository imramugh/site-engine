import type { Payload } from 'payload'
import { SiteSnapshotSchema } from '@site-engine/contract'
import { changeSetHash } from './publishing'
import { exactQualityProof } from './review-quality'

type RecordValue = Record<string, unknown>
type CapturedChange = { collection: string; id: string; before?: unknown; after?: unknown }

export type ReviewBlockChange = {
  id: string
  type: string
  label: string
  summary: string
  fields: string[]
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

export function routeForReviewPreview(manifest: unknown, includedChangeKeys: unknown): { path: string; pageID?: string } {
  const snapshot = SiteSnapshotSchema.parse(manifest)
  const pageID = Array.isArray(includedChangeKeys) ? includedChangeKeys.find((key): key is string => typeof key === 'string' && key.startsWith('pages:'))?.slice('pages:'.length) : undefined
  const page = snapshot.pages.find((candidate) => candidate.id === pageID)
  if (!page) return { path: '/' }
  if (page.id === snapshot.settings.homepageId) return { path: '/', pageID: page.id }
  const section = snapshot.settings.sections.find((candidate) => candidate.id === page.sectionId)
  if (!section) return { path: '/', pageID: page.id }
  const pages = new Map(snapshot.pages.map((candidate) => [candidate.id, candidate]))
  const ancestors: string[] = []
  let parent = page.parentId ? pages.get(page.parentId) : undefined
  while (parent && parent.id !== section.landingPageId) { ancestors.unshift(parent.slug); parent = parent.parentId ? pages.get(parent.parentId) : undefined }
  return { path: `/${[section.slug, ...ancestors, page.slug].filter(Boolean).join('/')}`, pageID: page.id }
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
    changedBlocks.push({ id, type: typeof value.type === 'string' ? value.type : 'block', label: labelFor(value), summary, fields })
  }
  const pageFields = changedFields(before, after).filter((field) => field !== 'blocks')
  const otherChanges = changes.filter((change) => change !== pageChange).map((change) => ({ collection: change.collection, id: change.id, fields: changedFields(change.before, change.after) }))
  return { changedBlocks, pageFields, otherChanges }
}

export async function loadReviewModeData(payload: Payload, id: string): Promise<ReviewModeData> {
  const set = await payload.findByID({ collection: 'change-sets', id, depth: 0, overrideAccess: true })
  const preview = set.preview as { status?: unknown; jobID?: unknown; revision?: unknown; changeHash?: unknown; contentHash?: unknown; includedChangeKeys?: unknown; baselineSnapshotID?: unknown; baselineSequence?: unknown; liveManifestHash?: unknown; proposedManifestHash?: unknown } | undefined
  if (!preview || preview.status !== 'ready' || typeof preview.jobID !== 'string') throw new Error('This review does not have a ready comparison.')
  const job = await payload.findByID({ collection: 'preview-render-jobs', id: preview.jobID, depth: 0, overrideAccess: true })
  const changes = Array.isArray(set.changes) ? set.changes as CapturedChange[] : []
  if (job.status !== 'completed' || !job.artifactDigest || relationID(job.changeSet) !== String(set.id) || String(job.id) !== preview.jobID || Number(set.revision) !== Number(job.reviewRevision) || Number(preview.revision) !== Number(job.reviewRevision) || preview.changeHash !== job.changeHash || changeSetHash(changes as never[]) !== job.changeHash || preview.liveManifestHash !== job.liveManifestHash || preview.proposedManifestHash !== job.proposedManifestHash) throw new Error('This comparison is no longer current.')
  const route = routeForReviewPreview(job.proposedManifest, job.includedChangeKeys)
  const described = describeReviewChanges(changes, route.pageID)
  const quality = set.quality as ReviewQuality | undefined
  const currentProof = typeof preview.contentHash === 'string' && Array.isArray(preview.includedChangeKeys) && preview.includedChangeKeys.every((value): value is string => typeof value === 'string') && Number.isInteger(preview.baselineSequence) && quality?.proof?.previewJobID === preview.jobID && exactQualityProof(quality, { revision: Number(set.revision), changeHash: String(job.changeHash), contentHash: preview.contentHash, includedChangeKeys: preview.includedChangeKeys, baselineSnapshotID: typeof preview.baselineSnapshotID === 'string' ? preview.baselineSnapshotID : undefined, baselineSequence: Number(preview.baselineSequence) })
  return {
    id: String(set.id), name: String(set.name), state: String(set.state), revision: Number(set.revision), previewJobID: preview.jobID,
    path: route.path, pageID: route.pageID, ...described, quality,
    approvalProof: currentProof ? quality?.proof : undefined,
    reviewComments: Array.isArray(set.reviewComments) ? set.reviewComments as ReviewModeData['reviewComments'] : [],
  }
}
