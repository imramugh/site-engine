import { describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'
import { checkSiteSnapshot } from '@site-engine/checks'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { attachConfiguredAIStatus } from '../src/ai-quality-status'

describe('deterministic audit AI availability', () => {
  it('distinguishes a configured provider from a performed AI check without exposing credentials', async () => {
    const find = vi.fn().mockResolvedValue({ docs: [{ encryptedCredential: 'synthetic-encrypted-secret', model: 'reviewed-model', health: 'connected' }] })
    const report = checkSiteSnapshot(neutralFixture)
    const result = await attachConfiguredAIStatus({ find } as unknown as Payload, report)
    expect(result.ai).toMatchObject({ status: 'not-run', code: 'AI_CHECKS_NOT_RUN' })
    expect(result.issues).toEqual(report.issues)
    expect(result.publishable).toBe(report.publishable)
    expect(JSON.stringify(result)).not.toContain('synthetic-encrypted-secret')
    expect(find).toHaveBeenCalledTimes(1)
    expect(find.mock.calls[0]?.[0].where).toEqual({ and: [{ encryptedCredential: { exists: true } }, { health: { equals: 'connected' } }] })
  })

  it('preserves deterministic results when the configuration read fails', async () => {
    const payload = { find: vi.fn().mockRejectedValue(new Error('internal configuration read failure')) } as unknown as Payload
    const report = checkSiteSnapshot(neutralFixture)
    const result = await attachConfiguredAIStatus(payload, report)
    expect(result.issues).toEqual(report.issues)
    expect(result.publishable).toBe(report.publishable)
    expect(result.ai.status).toBe('not-run')
    expect(JSON.stringify(result)).not.toContain('internal configuration read failure')
  })

  it.each([{ docs: [] }, { docs: [{ encryptedCredential: '', model: 'reviewed-model' }] }, { docs: [{ encryptedCredential: 'synthetic-secret', model: '' }] }])('reports unavailable for unusable configuration $docs', async ({ docs }) => {
    const payload = { find: vi.fn().mockResolvedValue({ docs }) } as unknown as Payload
    const result = await attachConfiguredAIStatus(payload, checkSiteSnapshot(neutralFixture))
    expect(result.ai).toMatchObject({ status: 'unavailable', code: 'AI_PROVIDER_UNAVAILABLE' })
  })
})
