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
let payload: any; let enqueueConfiguredAIJob: any; let lifecycle: any; let executor: any; let route: any; let encryptCredential: any; let ownerID: string
beforeAll(async () => { const [{ getPayload }, config, service, integration] = await Promise.all([import('payload'), import('../payload.config.js'), import('../src/configured-ai-jobs.js'), import('../src/integrations.js')]); payload = await getPayload({ config: config.default }); enqueueConfiguredAIJob = service.enqueueConfiguredAIJob; route = await import('../app/api/ai-jobs/route.js'); lifecycle = await import('../src/configured-ai-job-lifecycle.js'); executor = await import('../src/configured-ai-job-execution.js'); encryptCredential = integration.encryptCredential })
beforeEach(async () => { await payload.db.client.execute('DELETE FROM provider_usage_reservations'); await payload.db.client.execute('DELETE FROM configured_ai_jobs'); await payload.db.client.execute('DELETE FROM auth_sessions'); await payload.db.client.execute('DELETE FROM integration_configurations'); await payload.db.client.execute('DELETE FROM audit_events'); await payload.db.client.execute('DELETE FROM users'); const owner = await payload.create({ collection: 'users', data: { email: 'owner@example.test', name: 'Owner', roles: ['owner'] }, overrideAccess: true }); ownerID = owner.id; await payload.create({ collection: 'integration-configurations', data: { provider: 'openai', model: 'gpt-test', encryptedCredential: encryptCredential('synthetic-secret', 'openai'), credentialFingerprint: 'fingerprint', health: 'unknown', inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 2, pricingSource: 'https://prices.example.test', pricingAsOf: '2026-10-04T00:00:00.000Z' }, overrideAccess: true }) })
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
    const listed = await route.GET(new Request('http://cms.test/api/ai-jobs', { headers: { cookie } })); expect(listed.status).toBe(200); const json = await listed.json(); expect(JSON.stringify(json)).not.toContain('bounded prompt'); expect(json.jobs[0]).toMatchObject({ provider: 'openai', state: 'queued' }); expect(JSON.stringify(json)).not.toContain('configurationSnapshot')
  })
  it('shows a completed result and total cost only to the owning Owner', async () => {
    const created = await enqueueConfiguredAIJob(payload, ownerID, { ...input, idempotencyKey: 'owner-result-key-1234' }); const claimed = await lifecycle.claimConfiguredAIJob(payload, 'worker', 1_000)
    await lifecycle.beginConfiguredAIJob(payload, created.job.id, claimed.leaseToken, 1_001)
    await lifecycle.completeConfiguredAIJob(payload, created.job.id, claimed.leaseToken, { output: 'owner-only generated text', usageCostMicroUsd: null, reservedMicroUsd: 120, costStatus: 'reserved', usedProvider: 'openai', fallbackUsed: true }, 1_002)
    const other = await payload.create({ collection: 'users', data: { email: 'other-owner@example.test', name: 'Other owner', roles: ['owner'] }, overrideAccess: true })
    await enqueueConfiguredAIJob(payload, other.id, { ...input, input: 'other private prompt', idempotencyKey: 'other-owner-job-key' })
    const cookie = await session(await payload.findByID({ collection: 'users', id: ownerID, overrideAccess: true }))
    const response = await route.GET(new Request('http://cms.test/api/ai-jobs', { headers: { cookie } })); const body = await response.json()
    expect(body.jobs).toHaveLength(1); expect(body.jobs[0]).toMatchObject({ state: 'completed', usedProvider: 'openai', fallbackUsed: true, result: { output: 'owner-only generated text', reservedMicroUsd: 120, usageCostMicroUsd: null, costStatus: 'reserved' } })
    expect(JSON.stringify(body)).not.toContain('other private prompt')
  })
})

describe('configured AI job enqueue safety', () => {
  it("rejects a self fallback before creating a job or audit event", async () => {
    await expect(enqueueConfiguredAIJob(payload, ownerID, { ...input, fallbackProvider: "openai" })).rejects.toThrow("AI_JOB_UNAVAILABLE")
    expect((await payload.count({ collection: "configured-ai-jobs", overrideAccess: true })).totalDocs).toBe(0)
    expect((await payload.count({ collection: "audit-events", overrideAccess: true })).totalDocs).toBe(0)
  })

  it('fails closed for a missing fallback and preserves immutable intent fields', async () => {
    await expect(enqueueConfiguredAIJob(payload, ownerID, { ...input, fallbackProvider: 'anthropic' })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    const created = await enqueueConfiguredAIJob(payload, ownerID, input)
    const updated = await payload.update({ collection: 'configured-ai-jobs', id: created.job.id, data: { input: 'tampered', provider: 'anthropic', maxOutputTokens: 999, configurationSnapshot: [], state: 'running' }, overrideAccess: true })
    expect(updated).toMatchObject({ input: input.input, provider: 'openai', maxOutputTokens: input.maxOutputTokens, state: 'running' })
    expect(updated.configurationSnapshot).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'openai', monthlyCapMicroUsd: null, credentialFingerprint: 'fingerprint' })]))
  })
})

describe('configured AI job lease lifecycle', () => {
  const reserved = { output: 'synthetic output', usageCostMicroUsd: null, reservedMicroUsd: 120, costStatus: 'reserved' } as const
  const actual = { output: 'synthetic output', usageCostMicroUsd: 91, reservedMicroUsd: 120, costStatus: 'actual' } as const
  const queued = () => enqueueConfiguredAIJob(payload, ownerID, { ...input, idempotencyKey: `lifecycle-${randomBytes(8).toString('hex')}` })

  it('gives concurrent claims one winner', async () => {
    const job = await queued()
    const claims = await Promise.all(Array.from({ length: 4 }, (_, index) => lifecycle.claimConfiguredAIJob(payload, `worker-${index}`, 1_000)))
    const winners = claims.filter(Boolean)
    expect(winners).toHaveLength(1)
    expect(winners[0]!.job.id).toBe(job.job.id)
  })

  // These pagination fixtures perform hundreds of real transactional writes.
  // Their setup budget is separate from the worker's lease/claim semantics.
  it('skips the first hundred active leases to claim the next eligible queued job', { timeout: 30_000 }, async () => {
    for (let index = 0; index < 100; index += 1) {
      const active = await queued()
      await payload.update({ collection: 'configured-ai-jobs', id: active.job.id, data: { state: 'running', leaseToken: `active-${index}`, leaseExpiresAt: new Date(61_000).toISOString() }, overrideAccess: true })
    }
    const eligible = await queued()
    await expect(lifecycle.claimConfiguredAIJob(payload, 'worker', 1_000)).resolves.toMatchObject({ job: { id: eligible.job.id } })
  })

  it('quarantines invalid leases without scanning healthy running jobs and claims eligible work', { timeout: 30_000 }, async () => {
    for (let index = 0; index < 101; index += 1) {
      const active = await queued()
      await payload.update({ collection: 'configured-ai-jobs', id: active.job.id, data: { state: 'running', leaseToken: `healthy-${index}`, leaseExpiresAt: new Date(61_000).toISOString() }, overrideAccess: true })
    }
    const malformed = await queued()
    await payload.update({ collection: 'configured-ai-jobs', id: malformed.job.id, data: { state: 'running', leaseToken: 'malformed', leaseExpiresAt: new Date(61_000).toISOString() }, overrideAccess: true })
    await payload.db.client.execute({ sql: 'UPDATE configured_ai_jobs SET lease_expires_at = ? WHERE id = ?', args: ['not-a-date', malformed.job.id] })
    const eligible = await queued()
    await expect(lifecycle.claimConfiguredAIJob(payload, 'worker', 1_000)).resolves.toMatchObject({ job: { id: eligible.job.id } })
    await expect(payload.findByID({ collection: 'configured-ai-jobs', id: malformed.job.id, overrideAccess: true })).resolves.toMatchObject({ state: 'manual-review', failureCode: 'LEASE_INVALID_TIMESTAMP' })
  })

  it('moves a queued job with recorded dispatch to manual review instead of reclaiming it', async () => {
    const job = await queued()
    await payload.update({ collection: 'configured-ai-jobs', id: job.job.id, data: { dispatchStartedAt: new Date(1_000).toISOString() }, overrideAccess: true })
    expect(await lifecycle.claimConfiguredAIJob(payload, 'worker', 1_001)).toBeUndefined()
    await expect(payload.findByID({ collection: 'configured-ai-jobs', id: job.job.id, overrideAccess: true })).resolves.toMatchObject({ state: 'manual-review', failureCode: 'DISPATCH_WITHOUT_LEASE' })
  })

  it('denies a second parallel begin before a second transport intent can be sent', async () => {
    const job = await queued(); const claim = await lifecycle.claimConfiguredAIJob(payload, 'worker', 1_000)
    const starts = await Promise.allSettled([lifecycle.beginConfiguredAIJob(payload, job.job.id, claim.leaseToken, 1_001), lifecycle.beginConfiguredAIJob(payload, job.job.id, claim.leaseToken, 1_001)])
    expect(starts.filter((start) => start.status === 'fulfilled')).toHaveLength(1)
    expect(starts.filter((start) => start.status === 'rejected')[0]).toMatchObject({ reason: expect.objectContaining({ message: 'ALREADY_DISPATCHED' }) })
  })

  it('rejects renewal by a stale token after an unbegun lease is reclaimed', async () => {
    const job = await queued(); const first = await lifecycle.claimConfiguredAIJob(payload, 'worker', 1_000)
    const reclaimed = await lifecycle.claimConfiguredAIJob(payload, 'worker', 61_001)
    expect(reclaimed.leaseToken).not.toBe(first.leaseToken)
    await expect(lifecycle.renewConfiguredAIJob(payload, job.job.id, first.leaseToken, 61_002)).rejects.toThrow('LEASE_INVALID')
    await expect(lifecycle.renewConfiguredAIJob(payload, job.job.id, reclaimed.leaseToken, 61_002)).resolves.toMatchObject({ id: job.job.id })
  })

  it('requires begin and the current token, accepts canonical result replay, and rejects a changed proof', async () => {
    const job = await queued(); const claim = await lifecycle.claimConfiguredAIJob(payload, 'worker', 1_000)
    await expect(lifecycle.completeConfiguredAIJob(payload, job.job.id, claim.leaseToken, reserved, 1_001)).rejects.toThrow('DISPATCH_NOT_BEGUN')
    await lifecycle.beginConfiguredAIJob(payload, job.job.id, claim.leaseToken, 1_001)
    await expect(lifecycle.completeConfiguredAIJob(payload, job.job.id, 'wrong-token', reserved, 1_002)).rejects.toThrow('LEASE_INVALID')
    await expect(lifecycle.completeConfiguredAIJob(payload, job.job.id, claim.leaseToken, actual, 1_002)).resolves.toMatchObject({ state: 'completed', costStatus: 'actual' })
    await expect(lifecycle.completeConfiguredAIJob(payload, job.job.id, 'wrong-token', actual, 1_003)).rejects.toThrow('LEASE_INVALID')
    await expect(lifecycle.completeConfiguredAIJob(payload, job.job.id, claim.leaseToken, { costStatus: 'actual', reservedMicroUsd: 120, output: 'synthetic output', usageCostMicroUsd: 91 }, 61_003)).resolves.toMatchObject({ state: 'completed' })
    await expect(lifecycle.completeConfiguredAIJob(payload, job.job.id, claim.leaseToken, { ...actual, output: 'different synthetic output' }, 61_003)).rejects.toThrow('COMPLETION_CONFLICT')
  })

  it('accepts reserved money while rejecting invalid bounded completion values', async () => {
    const job = await queued(); const claim = await lifecycle.claimConfiguredAIJob(payload, 'worker', 1_000)
    await lifecycle.beginConfiguredAIJob(payload, job.job.id, claim.leaseToken, 1_001)
    await expect(lifecycle.completeConfiguredAIJob(payload, job.job.id, claim.leaseToken, reserved, 1_002)).resolves.toMatchObject({ costStatus: 'reserved' })
    await expect(lifecycle.completeConfiguredAIJob(payload, job.job.id, claim.leaseToken, { ...actual, usageCostMicroUsd: null }, 1_003)).rejects.toThrow('COMPLETION_INVALID')
    await expect(lifecycle.completeConfiguredAIJob(payload, job.job.id, claim.leaseToken, { ...reserved, output: 'x'.repeat(100_001) }, 1_003)).rejects.toThrow('COMPLETION_INVALID')
  })

  it('moves expired begun work to manual review without exposing its input or output in audit metadata', async () => {
    const job = await queued(); const claim = await lifecycle.claimConfiguredAIJob(payload, 'worker', 1_000)
    await lifecycle.beginConfiguredAIJob(payload, job.job.id, claim.leaseToken, 1_001)
    expect(await lifecycle.claimConfiguredAIJob(payload, 'worker', 70_000)).toBeUndefined()
    expect(await payload.findByID({ collection: 'configured-ai-jobs', id: job.job.id, overrideAccess: true })).toMatchObject({ state: 'manual-review', failureCode: 'LEASE_EXPIRED_AFTER_DISPATCH' })
    await expect(lifecycle.completeConfiguredAIJob(payload, job.job.id, claim.leaseToken, reserved, 70_001)).rejects.toThrow('LEASE_INVALID')
    const audit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'ai.job_manual_review' } }, overrideAccess: true })
    expect(audit.docs).toHaveLength(1)
    expect(JSON.stringify(audit.docs[0])).not.toContain('bounded prompt')
    expect(JSON.stringify(audit.docs[0])).not.toContain('synthetic output')
  })

  it('fails closed when a lease expiry timestamp is invalid', async () => {
    const job = await queued(); const claim = await lifecycle.claimConfiguredAIJob(payload, 'worker', 1_000)
    await payload.db.client.execute({ sql: 'UPDATE configured_ai_jobs SET lease_expires_at = ? WHERE id = ?', args: ['invalid-lease-date', job.job.id] })
    await expect(lifecycle.renewConfiguredAIJob(payload, job.job.id, claim.leaseToken, 1_001)).rejects.toThrow('LEASE_INVALID')
    await expect(lifecycle.beginConfiguredAIJob(payload, job.job.id, claim.leaseToken, 1_001)).rejects.toThrow('LEASE_INVALID')
    expect(await lifecycle.claimConfiguredAIJob(payload, 'worker', 1_001)).toBeUndefined()
    await expect(payload.findByID({ collection: 'configured-ai-jobs', id: job.job.id, overrideAccess: true })).resolves.toMatchObject({ state: 'manual-review', failureCode: 'LEASE_INVALID_TIMESTAMP', leaseToken: null, leaseExpiresAt: null })
    const audit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'ai.job_manual_review' } }, overrideAccess: true })
    expect(JSON.stringify(audit.docs)).not.toContain('bounded prompt')
  })
})

describe('configured AI job CMS execution', () => {
  const now = new Date('2026-10-04T12:00:00.000Z')
  const queued = () => enqueueConfiguredAIJob(payload, ownerID, { ...input, idempotencyKey: `execution-${randomBytes(8).toString('hex')}` })
  async function claim() { return lifecycle.claimConfiguredAIJob(payload, 'cms-executor', now.getTime()) }
  async function usableConfiguration() {
    const configuration = (await payload.find({ collection: 'integration-configurations', limit: 1, overrideAccess: true })).docs[0]
    return configuration
  }
  const answer = () => Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'safe result' }] }], usage: { input_tokens: 2, output_tokens: 3 } })

  it('claims, begins, executes and completes through SQLite with immutable provider metadata', async () => {
    await usableConfiguration(); const queuedJob = await queued(); const claimed = await claim(); let calls = 0
    await expect(executor.executeClaimedConfiguredAIJob(payload, claimed, { now, transport: async () => { calls += 1; return answer() } })).resolves.toMatchObject({ id: queuedJob.job.id, state: 'completed', usedProvider: 'openai', fallbackUsed: false, costStatus: 'actual' })
    expect(calls).toBe(1)
    const reservations = await payload.find({ collection: 'provider-usage-reservations', overrideAccess: true })
    expect(reservations.docs).toHaveLength(1)
    expect(reservations.docs[0]).toMatchObject({ executionKey: executor.configuredAIReservationKey(queuedJob.job.id, 'openai'), state: 'settled', settledMicroUsd: 2 })
    const audit = await payload.find({ collection: 'audit-events', overrideAccess: true })
    expect(JSON.stringify(audit.docs)).not.toContain('bounded prompt')
    expect(JSON.stringify(audit.docs)).not.toContain('safe result')
  })

  it('refuses a queued job after its immutable provider settings change without provider I/O', async () => {
    const configuration = await usableConfiguration(); const queuedJob = await queued(); const claimed = await claim(); let calls = 0
    await payload.update({ collection: 'integration-configurations', id: configuration.id, data: { providerSettings: { imageInput: false } }, overrideAccess: true })
    await expect(executor.executeClaimedConfiguredAIJob(payload, claimed, { now, transport: async () => { calls += 1; return answer() } })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    expect(calls).toBe(0)
    await expect(payload.findByID({ collection: 'configured-ai-jobs', id: queuedJob.job.id, overrideAccess: true })).resolves.toMatchObject({ state: 'failed', failureCode: 'CONFIGURATION_SNAPSHOT_STALE', dispatchStartedAt: null })
  })

  it('fails closed before dispatch when the snapshotted configuration rotates', async () => {
    const configuration = await usableConfiguration(); const queuedJob = await queued(); const claimed = await claim(); let calls = 0
    await payload.update({ collection: 'integration-configurations', id: configuration.id, data: { model: 'rotated-model' }, overrideAccess: true })
    await expect(executor.executeClaimedConfiguredAIJob(payload, claimed, { now, transport: async () => { calls += 1; return answer() } })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    expect(calls).toBe(0)
    await expect(payload.findByID({ collection: 'configured-ai-jobs', id: queuedJob.job.id, overrideAccess: true })).resolves.toMatchObject({ state: 'failed', failureCode: 'CONFIGURATION_SNAPSHOT_STALE', dispatchStartedAt: null })
  })

  it('retains an ambiguous reservation and never dispatches or reserves twice on retry', async () => {
    await usableConfiguration(); const queuedJob = await queued(); const claimed = await claim(); let calls = 0
    const ambiguous = async () => { calls += 1; throw new Error('connection dropped after provider acceptance') }
    await expect(executor.executeClaimedConfiguredAIJob(payload, claimed, { now, transport: ambiguous })).rejects.toThrow()
    await expect(executor.executeClaimedConfiguredAIJob(payload, claimed, { now, transport: ambiguous })).rejects.toThrow()
    expect(calls).toBe(1)
    const reservations = await payload.find({ collection: 'provider-usage-reservations', overrideAccess: true })
    expect(reservations.docs).toHaveLength(1)
    expect(reservations.docs[0]).toMatchObject({ executionKey: executor.configuredAIReservationKey(queuedJob.job.id, 'openai'), state: 'reserved', settledMicroUsd: null })
    await expect(payload.findByID({ collection: 'configured-ai-jobs', id: queuedJob.job.id, overrideAccess: true })).resolves.toMatchObject({ state: 'manual-review', failureCode: 'DISPATCH_OUTCOME_UNKNOWN' })
  })

  it('refuses late completion after the lease expires and quarantines the begun dispatch', async () => {
    await usableConfiguration(); const queuedJob = await queued(); const claimed = await claim(); let time = now.getTime(); let calls = 0
    const clock = () => new Date(time)
    await expect(executor.executeClaimedConfiguredAIJob(payload, claimed, { clock, transport: async () => { calls += 1; time += 60_001; return answer() } })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    expect(calls).toBe(1)
    await expect(executor.executeClaimedConfiguredAIJob(payload, claimed, { clock, transport: async () => { calls += 1; return answer() } })).rejects.toThrow()
    expect(calls).toBe(1)
    await expect(payload.findByID({ collection: 'configured-ai-jobs', id: queuedJob.job.id, overrideAccess: true })).resolves.toMatchObject({ state: 'manual-review', failureCode: 'DISPATCH_OUTCOME_UNKNOWN' })
  })

  it('does not let a stale claimed payload change a newer lease', async () => {
    await usableConfiguration(); const queuedJob = await queued(); const first = await claim()
    const second = await lifecycle.claimConfiguredAIJob(payload, 'replacement-worker', now.getTime() + 60_001)
    await expect(executor.executeClaimedConfiguredAIJob(payload, first, { now, transport: async () => answer() })).rejects.toThrow('LEASE_INVALID')
    await expect(payload.findByID({ collection: 'configured-ai-jobs', id: queuedJob.job.id, overrideAccess: true })).resolves.toMatchObject({ state: 'running', leaseToken: second.leaseToken, dispatchStartedAt: null })
  })

  it('leaves an active begun lease alone when the same claim is submitted twice', async () => {
    await usableConfiguration(); const queuedJob = await queued(); const claimed = await claim(); let calls = 0; let release: (() => void) | undefined; let entered: (() => void) | undefined
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const first = executor.executeClaimedConfiguredAIJob(payload, claimed, { now, transport: async () => { calls += 1; entered?.(); await new Promise<void>(resolve => { release = resolve }); return answer() } })
    await enteredPromise
    await expect(executor.executeClaimedConfiguredAIJob(payload, claimed, { now, transport: async () => { calls += 1; return answer() } })).rejects.toThrow('ALREADY_DISPATCHED')
    expect(calls).toBe(1)
    await expect(payload.findByID({ collection: 'configured-ai-jobs', id: queuedJob.job.id, overrideAccess: true })).resolves.toMatchObject({ state: 'running', leaseToken: claimed.leaseToken, dispatchStartedAt: expect.any(String) })
    release?.()
    await expect(first).resolves.toMatchObject({ state: 'completed' })
  })

  it('reports the full held reservation when an unavailable primary falls back successfully', async () => {
    await usableConfiguration()
    await payload.create({ collection: 'integration-configurations', data: { provider: 'anthropic', model: 'claude-test', encryptedCredential: encryptCredential('fallback-secret', 'anthropic'), credentialFingerprint: 'fallback-fingerprint', health: 'unknown', inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 2, pricingSource: 'https://prices.example.test', pricingAsOf: '2026-10-04T00:00:00.000Z' }, overrideAccess: true })
    const queuedJob = await enqueueConfiguredAIJob(payload, ownerID, { ...input, fallbackProvider: 'anthropic', idempotencyKey: `fallback-${randomBytes(8).toString('hex')}` }); const claimed = await claim(); let calls = 0
    await expect(executor.executeClaimedConfiguredAIJob(payload, claimed, { now, transport: async (request: Request) => { calls += 1; if (request.url.includes('openai.com')) throw new Error('synthetic timeout'); return Response.json({ content: [{ type: 'text', text: 'fallback result' }], usage: { input_tokens: 2, output_tokens: 3 } }) } })).resolves.toMatchObject({ state: 'completed', usedProvider: 'anthropic', fallbackUsed: true, costStatus: 'reserved' })
    expect(calls).toBe(2)
    const completed = await payload.findByID({ collection: 'configured-ai-jobs', id: queuedJob.job.id, overrideAccess: true }) as any
    expect(JSON.parse(completed.result)).toMatchObject({ reservedMicroUsd: 4, usageCostMicroUsd: null, costStatus: 'reserved', usedProvider: 'anthropic', fallbackUsed: true })
    const reservations = await payload.find({ collection: 'provider-usage-reservations', overrideAccess: true })
    expect(reservations.docs).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'reserved' }), expect.objectContaining({ state: 'settled', settledMicroUsd: 2 })]))
  })

  it('fails closed if configuration rotates between preflight and transactional reservation', async () => {
    const primary = await usableConfiguration()
    await payload.create({ collection: 'integration-configurations', data: { provider: 'anthropic', model: 'claude-test', encryptedCredential: encryptCredential('fallback-secret', 'anthropic'), credentialFingerprint: 'fallback-fingerprint', health: 'unknown', inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 2, pricingSource: 'https://prices.example.test', pricingAsOf: '2026-10-04T00:00:00.000Z' }, overrideAccess: true })
    const queuedJob = await enqueueConfiguredAIJob(payload, ownerID, { ...input, fallbackProvider: 'anthropic', idempotencyKey: `rotation-race-${randomBytes(8).toString('hex')}` }); const claimed = await claim(); let configReads = 0; let calls = 0
    const racedPayload = Object.create(payload) as any
    racedPayload.findByID = async (args: any) => {
      if (args.collection === 'integration-configurations' && ++configReads === 3) await payload.update({ collection: 'integration-configurations', id: primary.id, data: { model: 'rotated-in-transaction' }, overrideAccess: true })
      return payload.findByID(args)
    }
    await expect(executor.executeClaimedConfiguredAIJob(racedPayload, claimed, { now, transport: async () => { calls += 1; return answer() } })).rejects.toThrow('AI_JOB_UNAVAILABLE')
    expect(calls).toBe(0)
    await expect(payload.findByID({ collection: 'configured-ai-jobs', id: queuedJob.job.id, overrideAccess: true })).resolves.toMatchObject({ state: 'manual-review', failureCode: 'DISPATCH_OUTCOME_UNKNOWN' })
  })
})
