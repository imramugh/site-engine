const hashPattern = /^[a-f0-9]{64}$/
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Preview evidence is invalid.')
  return value as Record<string, unknown>
}
const keys = (value: Record<string, unknown>, expected: string[]) => {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error('Preview evidence is invalid.')
}
const validRoute = (value: unknown) => typeof value === 'string' && value.startsWith('/') && !/[?#%\\\s]/.test(value) && !value.includes('//') && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(value)

export type ScreenshotEvidence = { path: string; bytes: number; sha256: string; route: string; status: 200 | 404 }
type EvidenceIdentity = { version: 1; jobID: string; liveManifestHash: string; proposedManifestHash: string }
export type PreviewEvidence = EvidenceIdentity & (
  | { state: 'unavailable'; reason: 'SELECTED_PAGE_NOT_RENDERABLE' }
  | { state: 'available'; route: string; viewport: { width: 1440; height: 900 }; screenshots: { live: ScreenshotEvidence; proposed: ScreenshotEvidence } }
)

export function validatePreviewEvidence(value: unknown, identity: { id: string; liveManifestHash: unknown; proposedManifestHash: unknown }): PreviewEvidence {
  const manifest = object(value)
  const identityKeys = ['version', 'state', 'jobID', 'liveManifestHash', 'proposedManifestHash']
  if (manifest.version !== 1 || manifest.jobID !== identity.id ||
    manifest.liveManifestHash !== identity.liveManifestHash || manifest.proposedManifestHash !== identity.proposedManifestHash ||
    typeof manifest.liveManifestHash !== 'string' || !hashPattern.test(manifest.liveManifestHash) ||
    typeof manifest.proposedManifestHash !== 'string' || !hashPattern.test(manifest.proposedManifestHash)) throw new Error('Preview evidence is invalid.')
  if (manifest.state === 'unavailable') {
    keys(manifest, [...identityKeys, 'reason'])
    if (manifest.reason !== 'SELECTED_PAGE_NOT_RENDERABLE') throw new Error('Preview evidence is invalid.')
  } else {
    if (manifest.state !== 'available' || !validRoute(manifest.route)) throw new Error('Preview evidence is invalid.')
    keys(manifest, [...identityKeys, 'route', 'viewport', 'screenshots'])
    const viewport = object(manifest.viewport)
    keys(viewport, ['width', 'height'])
    if (viewport.width !== 1440 || viewport.height !== 900) throw new Error('Preview evidence is invalid.')
    const screenshots = object(manifest.screenshots)
    keys(screenshots, ['live', 'proposed'])
    for (const variant of ['live', 'proposed']) {
      const shot = object(screenshots[variant])
      keys(shot, ['path', 'bytes', 'sha256', 'route', 'status'])
      if (shot.path !== `evidence/${variant}.png` || !Number.isInteger(shot.bytes) || Number(shot.bytes) < 8 || Number(shot.bytes) > 5 * 1024 * 1024 ||
        typeof shot.sha256 !== 'string' || !hashPattern.test(shot.sha256) || !validRoute(shot.route) || (shot.status !== 200 && shot.status !== 404)) throw new Error('Preview evidence is invalid.')
    }
  }
  return structuredClone(manifest) as PreviewEvidence
}

export function previewEvidenceExpiresAt(completedAt: unknown, configuredDays = process.env.PREVIEW_EVIDENCE_RETENTION_DAYS ?? '30') {
  const days = Number(configuredDays), completed = typeof completedAt === 'string' ? Date.parse(completedAt) : NaN
  if (!Number.isInteger(days) || days < 1 || days > 365 || !Number.isFinite(completed)) return NaN
  return completed + days * 86_400_000
}
