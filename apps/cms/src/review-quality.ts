import type { Payload, PayloadRequest } from 'payload'
import { checkSiteSnapshot, type QualityReport } from '@site-engine/checks'
import { changeSetHash, canonicalHash } from './publishing'

type Preview = { status?: string; jobID?: string; revision?: number; changeHash?: string; contentHash?: string; includedChangeKeys?: string[]; baselineSnapshotID?: string; baselineSequence?: number }

/** Runs deterministic readiness checks against the completed immutable preview
 * artifact, never against mutable draft collections. */
export async function runReviewQuality(input: { payload: Payload; req: PayloadRequest; id: string }) {
  const set = await input.payload.findByID({ collection: 'change-sets', id: input.id, depth: 0, overrideAccess: true, req: input.req }) as unknown as Record<string, unknown>
  const preview = set.preview as Preview | undefined
  if (set.state !== 'submitted') throw new Error(`Cannot run quality for a ${String(set.state)} change set.`)
  if (preview?.status !== 'ready' || !preview.jobID || !preview.contentHash || !Array.isArray(preview.includedChangeKeys)) throw new Error('A ready private preview is required before quality can run.')
  const job = await input.payload.findByID({ collection: 'preview-render-jobs', id: preview.jobID, depth: 0, overrideAccess: true, req: input.req }) as unknown as Record<string, unknown>
  const changes = Array.isArray(set.changes) ? set.changes : []
  if (job.status !== 'completed' || Number(job.reviewRevision) !== Number(set.revision) || job.changeHash !== changeSetHash(changes) || canonicalHash(job.proposedManifest) !== preview.contentHash) throw new Error('The ready preview is no longer current.')
  const manifest = job.proposedManifest as { styleGuide?: unknown }
  const report = checkSiteSnapshot(job.proposedManifest, { asOf: String(set.submittedAt ?? set.updatedAt ?? new Date().toISOString()), style: manifest.styleGuide as NonNullable<Parameters<typeof checkSiteSnapshot>[1]>['style'] })
  const pins = job.versionPins as { themeVersion?: unknown; engineVersion?: unknown; contractVersion?: unknown } | undefined
  if (!pins || typeof pins.themeVersion !== 'string' || typeof pins.engineVersion !== 'string' || typeof pins.contractVersion !== 'string') throw new Error('The preview version pins are invalid.')
  const proof = { version: report.version, revision: Number(set.revision), changeHash: String(job.changeHash), contentHash: preview.contentHash, includedChangeKeys: [...preview.includedChangeKeys].sort(), baselineSnapshotID: preview.baselineSnapshotID, baselineSequence: preview.baselineSequence, previewJobID: preview.jobID, versionPins: { themeVersion: pins.themeVersion, engineVersion: pins.engineVersion, contractVersion: pins.contractVersion }, styleGuide: manifest.styleGuide, report }
  const quality = { checks: [{ name: 'deterministic-readiness', status: report.publishable ? 'passed' : 'failed', errors: report.blockers.map((item) => ({ code: item.code, path: item.path, message: item.message })) }], warnings: report.warnings.map((item) => `${item.code}: ${item.message}`), proof }
  await input.payload.update({ collection: 'change-sets', id: input.id, data: { quality }, overrideAccess: true, req: input.req, context: { editorialInternal: true } })
  return { report, proof }
}

export function exactQualityProof(quality: unknown, expected: { revision: number; changeHash: string; contentHash: string; includedChangeKeys: readonly string[]; baselineSnapshotID?: string; baselineSequence: number }): boolean {
  const proof = quality && typeof quality === 'object' ? (quality as { proof?: Record<string, unknown> }).proof : undefined
  const report = proof?.report as QualityReport | undefined
  return Boolean(proof && report?.publishable && proof.revision === expected.revision && proof.changeHash === expected.changeHash && proof.contentHash === expected.contentHash && proof.baselineSnapshotID === expected.baselineSnapshotID && proof.baselineSequence === expected.baselineSequence && Array.isArray(proof.includedChangeKeys) && JSON.stringify([...proof.includedChangeKeys].sort()) === JSON.stringify([...expected.includedChangeKeys].sort()))
}
