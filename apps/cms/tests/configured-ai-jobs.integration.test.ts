import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-configured-ai-jobs-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'synthetic-configured-ai-job-payload-secret-that-is-long-enough'
process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64url')
let payload: any; let enqueueConfiguredAIJob: any; let ownerID: string
beforeAll(async () => { const [{ getPayload }, config, service] = await Promise.all([import('payload'), import('../payload.config.js'), import('../src/configured-ai-jobs.js')]); payload = await getPayload({ config: config.default }); enqueueConfiguredAIJob = service.enqueueConfiguredAIJob })
beforeEach(async () => { await payload.db.client.execute('DELETE FROM configured_ai_jobs'); await payload.db.client.execute('DELETE FROM integration_configurations'); await payload.db.client.execute('DELETE FROM audit_events'); await payload.db.client.execute('DELETE FROM users'); const owner = await payload.create({ collection: 'users', data: { email: 'owner@example.test', name: 'Owner', roles: ['owner'] }, overrideAccess: true }); ownerID = owner.id; await payload.create({ collection: 'integration-configurations', data: { provider: 'openai', model: 'gpt-test', encryptedCredential: 'v1.synthetic', credentialFingerprint: 'fingerprint', health: 'unknown', inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 2, pricingSource: 'https://prices.example.test', pricingAsOf: '2026-10-04T00:00:00.000Z' }, overrideAccess: true }) })
const input = { provider: 'openai', input: 'bounded prompt', maxOutputTokens: 12, idempotencyKey: 'same-request-key-1234' } as const

describe('configured AI jobs durable idempotency', () => {
  it('returns one durable job for concurrent equal actor/key/request submissions', async () => {
    const results = await Promise.all([enqueueConfiguredAIJob(payload, ownerID, input), enqueueConfiguredAIJob(payload, ownerID, input)])
    expect(new Set(results.map((result: any) => result.job.id)).size).toBe(1)
    expect((await payload.find({ collection: 'configured-ai-jobs', overrideAccess: true })).docs).toHaveLength(1)
  })
  it('rejects a reused key with a different canonical request', async () => {
    await enqueueConfiguredAIJob(payload, ownerID, input)
    await expect(enqueueConfiguredAIJob(payload, ownerID, { ...input, input: 'different prompt' })).rejects.toThrow('IDEMPOTENCY_KEY_REUSED')
  })
})
