import { describe, expect, it } from 'vitest'
import { previewEvidenceExpiresAt, validatePreviewEvidence } from '../src/preview-evidence'

const id = '11111111-1111-4111-8111-111111111111'
const identity = { id, liveManifestHash: 'a'.repeat(64), proposedManifestHash: 'b'.repeat(64) }
const fixture = () => ({ version: 1, state: 'available', jobID: id, liveManifestHash: identity.liveManifestHash, proposedManifestHash: identity.proposedManifestHash, route: '/services/', viewport: { width: 1440, height: 900 }, screenshots: {
  live: { path: 'evidence/live.png', sha256: 'c'.repeat(64), bytes: 100, route: '/old-services/', status: 200 },
  proposed: { path: 'evidence/proposed.png', sha256: 'd'.repeat(64), bytes: 100, route: '/services/', status: 404 },
} })

describe('immutable preview screenshot metadata', () => {
  it('accepts typed evidence for renamed and removed pages without losing either route', () => {
    expect(validatePreviewEvidence(fixture(), identity)).toEqual(fixture())
    expect(validatePreviewEvidence({ version: 1, state: 'unavailable', jobID: id, liveManifestHash: identity.liveManifestHash, proposedManifestHash: identity.proposedManifestHash, reason: 'SELECTED_PAGE_NOT_RENDERABLE' }, identity).state).toBe('unavailable')
  })
  it.each([
    ['missing evidence', () => undefined],
    ['wrong identity', () => ({ ...fixture(), jobID: 'other' })],
    ['wrong version', () => ({ ...fixture(), version: 2 })],
    ['arbitrary metadata', () => ({ ...fixture(), secret: 'must-not-persist' })],
    ['unknown state with images', () => ({ ...fixture(), state: 'unavailable' })],
    ['wrong viewport', () => ({ ...fixture(), viewport: { width: 1, height: 1 } })],
    ['query data', () => ({ ...fixture(), route: '/?token=sensitive' })],
    ['path traversal', () => ({ ...fixture(), route: '/../private' })],
    ['encoded path', () => ({ ...fixture(), route: '/%2e%2e/private' })],
    ['missing before', () => ({ ...fixture(), screenshots: { proposed: fixture().screenshots.proposed } })],
    ['wrong file', () => ({ ...fixture(), screenshots: { ...fixture().screenshots, live: { ...fixture().screenshots.live, path: '../live.png' } } })],
    ['oversized file', () => ({ ...fixture(), screenshots: { ...fixture().screenshots, live: { ...fixture().screenshots.live, bytes: 5 * 1024 * 1024 + 1 } } })],
    ['numeric string status', () => ({ ...fixture(), screenshots: { ...fixture().screenshots, live: { ...fixture().screenshots.live, status: '200' } } })],
  ])('rejects %s', (_label, value) => expect(() => validatePreviewEvidence(value(), identity)).toThrow('invalid'))
  it('fails closed for malformed completion timestamps and invalid retention settings', () => {
    expect(previewEvidenceExpiresAt('2026-01-01T00:00:00Z', '30')).toBe(Date.parse('2026-01-31T00:00:00Z'))
    for (const days of ['0', '-1', 'NaN', '366', '1.5']) expect(Number.isNaN(previewEvidenceExpiresAt('2026-01-01T00:00:00Z', days))).toBe(true)
    for (const time of [undefined, null, 'not-a-date']) expect(Number.isNaN(previewEvidenceExpiresAt(time))).toBe(true)
  })
})
