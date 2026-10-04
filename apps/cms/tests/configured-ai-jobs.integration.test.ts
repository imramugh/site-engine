import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-configured-ai-jobs-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'synthetic-configured-ai-job-payload-secret-that-is-long-enough'
process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64url')
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
let payload: any; let enqueueConfiguredAIJob: any; let lifecycle: any; let route: any; let ownerID: string
beforeAll(async () => { const [{ getPayload }, config, service] = await Promise.all([import('payload'), import('../payload.config.js'), import('../src/configured-ai-jobs.js')]); payload = await getPayload({ config: config.default }); enqueueConfiguredAIJob = service.enqueueConfiguredAIJob; route = await import('../app/api/ai-jobs/route.js'); lifecycle = await import('../src/configured-ai-job-lifecycle.js') })
beforeEach(async () => { await payload.db.client.execute('DELETE FROM configured_ai_jobs'); await payload.db.client.execute('DELETE FROM auth_sessions'); await payload.db.client.execute('DELETE FROM integration_configurations'); await payload.db.client.execute('DELETE FROM audit_events'); await payload.db.client.execute('DELETE FROM users'); const owner = await payload.create({ collection: 'users', data: { email: 'owner@example.test', name: 'Owner', roles: ['owner'] }, overrideAccess: true }); ownerID = owner.id; await payload.create({ collection: 'integration-configurations', data: { provider: 'openai', model: 'gpt-test', encryptedCredential: 'v1.synthetic', credentialFingerprint: 'fingerprint', health: 'unknown', inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 2, pricingSource: 'https://prices.example.test', pricingAsOf: '2026-10-04T00:00:00.000Z' }, overrideAccess: true }) })
async function session(user: any, fresh = true) { const { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } = await import('../src/identity.js'); const token = newOpaqueToken(); const now = Date.now(); await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: new Date(now - (fresh ? 0 : 16 * 60_000)).toISOString(), lastSeenAt: new Date(now).toISOString(), expiresAt: new Date(now + 60 * 60_000).toISOString() }, overrideAccess: true }); return `${cookieName(SESSION_COOKIE)}=${token}` }
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


describe('configured AI jobs Owner route', () => {
  const request = (body: unknown, cookie?: string, origin = 'http://cms.test') => route.POST(new Request('http://cms.test/api/ai-jobs', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }))
  it('requires a fresh Owner, strict bounded input, snapshots nonsecret pricing, and redacts request input', async () => {
    const owner = await payload.findByID({ collection: 'users', id: ownerID, overrideAccess: true }); const cookie = await session(owner)
    expect((await request(input)).status).toBe(403)
    const editor = await payload.create({ collection: 'users', data: { email: 'editor@example.test', name: 'Editor', roles: ['editor'] }, overrideAccess: true })
    expect((await request(input, await session(editor))).status).toBe(403)
    expect((await request(input, cookie, 'http://wrong.test')).status).toBe(403)
    expect((await request({ ...input, extra: true }, cookie)).status).toBe(400)
    expect((await request(input, await session(owner, false))).status).toBe(403)
    const created = await request(input, cookie); expect(created.status).toBe(201)
    const job = (await created.json()).job; expect(job).toMatchObject({ state: 'queued', created: true })
    const duplicate = await request(input, cookie); expect(duplicate.status).toBe(200)
    expect((await request({ ...input, input: 'different bounded prompt' }, cookie)).status).toBe(409)
    const listed = await route.GET(new Request('http://cms.test/api/ai-jobs', { headers: { cookie } })); expect(listed.status).toBe(200); const json = await listed.json(); expect(JSON.stringify(json)).not.toContain('bounded prompt'); expect(json.jobs[0].configurationSnapshot[0]).toMatchObject({ provider: 'openai', model: 'gpt-test', inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 2, pricingSource: 'https://prices.example.test' })
  })
})

describe('configured AI job enqueue safety', () => {
  it('fails closed for a missing fallback and preserves immutable intent fields', async () => {
    await expect(enqueueConfiguredAIJob(payload, ownerID, { ...input, fallbackProvider: 'anthropic' })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    const created = await enqueueConfiguredAIJob(payload, ownerID, input)
    const updated = await payload.update({ collection: 'configured-ai-jobs', id: created.job.id, data: { input: 'tampered', provider: 'anthropic', maxOutputTokens: 999, configurationSnapshot: [], state: 'running' }, overrideAccess: true })
    expect(updated).toMatchObject({ input: input.input, provider: 'openai', maxOutputTokens: input.maxOutputTokens, state: 'running' })
    expect(updated.configurationSnapshot).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'openai', monthlyCapMicroUsd: null, credentialFingerprint: 'fingerprint' })]))
  })
})

describe('configured AI job lease lifecycle', () => { it('claims once, marks begun expired work for manual review, and rejects stale completion', async () => { const job = await enqueueConfiguredAIJob(payload, ownerID, input); const first = await lifecycle.claimConfiguredAIJob(payload, 'worker', 1_000); expect(first.job.id).toBe(job.job.id); expect(await lifecycle.claimConfiguredAIJob(payload, 'worker', 1_001)).toBeUndefined(); await lifecycle.beginConfiguredAIJob(payload, job.job.id, first.leaseToken, 1_002); expect(await lifecycle.claimConfiguredAIJob(payload, 'worker', 70_000)).toBeUndefined(); const stored = await payload.findByID({ collection: 'configured-ai-jobs', id: job.job.id, overrideAccess: true }); expect(stored.state).toBe('manual-review'); await expect(lifecycle.completeConfiguredAIJob(payload, job.job.id, first.leaseToken, { ok: true }, 70_001)).rejects.toThrow('LEASE_INVALID') }) })
