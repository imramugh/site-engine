import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { configureIntegration, revokeIntegration, testIntegrationConnection } from '../src/integration-configuration'
import { monitorIntegrationHealth } from '../src/integration-health-monitor'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-integration-access-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-integration-access'
process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64url')
process.env.EMERGENCY_TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString('base64url')
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
const { default: config } = await import('../payload.config.js')
const integrationRoute = await import('../app/api/integrations/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

async function freshSession(userID: string) {
  const token = newOpaqueToken(); const now = new Date().toISOString()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: userID, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  return `${cookieName(SESSION_COOKIE)}=${token}`
}

describe('ENG-023 integration configuration access', () => {
  it('returns only redacted, real capability state for the five-tab workspace', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'workspace-owner@example.test', name: 'Workspace owner', roles: ['owner'], emergencyTotpSecret: 'encrypted-local-secret' }, overrideAccess: true })
    const localUse = await payload.create({ collection: 'audit-events', data: { event: 'identity.local_signed_in', user: owner.id, detail: { mustNotEscape: 'private-audit-payload' } }, overrideAccess: true })
    const session = await freshSession(owner.id)
    Object.assign(process.env, {
      OAUTH_INTERNAL_ORIGIN: 'http://oauth.example.test', OAUTH_INTROSPECTION_SECRET: 'introspection-secret',
    })
    try {
      const response = await integrationRoute.GET(new Request('http://cms.test/api/integrations', { headers: { cookie: session } }))
      expect(response.status).toBe(200)
      const body = await response.json() as Record<string, any>
      expect(body.capabilities).toEqual({
        identity: {
          local: { configured: true, users: 1, lastUsedAt: localUse.createdAt, sensitiveReauthMinutes: 15 },
        },
        assistants: { oauthConfigured: true, endpoint: 'http://cms.test/mcp' },
        email: { workerConfigured: false },
        notifications: { queued: 0, delivered: 0, failed: 0 },
      })
      expect(JSON.stringify(body)).not.toContain('encrypted-local-secret')
      expect(JSON.stringify(body)).not.toContain('introspection-secret')
      expect(JSON.stringify(body)).not.toContain('OIDC_GOOGLE_CLIENT_SECRET')
      expect(JSON.stringify(body)).not.toContain('microsoft-client-must-not-escape')
      expect(JSON.stringify(body)).not.toContain('microsoft-secret-must-not-escape')
      expect(JSON.stringify(body)).not.toContain('issuer-user-must-not-escape')
      expect(JSON.stringify(body)).not.toContain('issuer-password-must-not-escape')
      expect(JSON.stringify(body)).not.toContain('?private=query')
      expect(JSON.stringify(body)).not.toContain('private-audit-payload')
    } finally {
      for (const name of ['OAUTH_INTERNAL_ORIGIN', 'OAUTH_INTROSPECTION_SECRET']) delete process.env[name]
    }
  })

  it('denies direct owner CRUD so credential changes can only use the audited route', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'integration-owner@example.test', name: 'Integration owner', roles: ['owner'] }, overrideAccess: true })
    const data = { provider: 'openai' as const, model: 'synthetic-model', health: 'unknown' as const }
    await expect(payload.create({ collection: 'integration-configurations', data, user: owner, overrideAccess: false })).rejects.toThrow()
    await expect(payload.find({ collection: 'integration-configurations', user: owner, overrideAccess: false })).rejects.toThrow()
  })

  it('persists normalized adapter settings through the fresh Owner route without returning the credential', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'azure-owner@example.test', name: 'Azure owner', roles: ['owner'] }, overrideAccess: true })
    const session = await freshSession(owner.id)
    const response = await integrationRoute.POST(new Request('http://cms.test/api/integrations', { method: 'POST', headers: { origin: 'http://cms.test', cookie: session, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'configure', provider: 'azure-openai', model: 'reviewed-deployment', credential: 'azure-write-only-secret', fallbackProvider: null, providerSettings: { endpoint: 'https://reviewed-resource.openai.azure.com', imageInput: false }, monthlyCapMicroUsd: null, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 2, pricingSource: 'https://prices.example.test/azure', pricingAsOf: '2026-10-11T00:00:00.000Z' }) }))
    expect(response.status).toBe(201)
    const body = await response.json() as Record<string, unknown>
    expect(JSON.stringify(body)).not.toContain('azure-write-only-secret')
    expect(body).toMatchObject({ integration: { provider: 'azure-openai', providerSettings: { endpoint: 'https://reviewed-resource.openai.azure.com/openai/v1', imageInput: false } } })
    const stored = (await payload.find({ collection: 'integration-configurations', where: { provider: { equals: 'azure-openai' } }, overrideAccess: true })).docs[0] as any
    expect(stored.providerSettings).toEqual({ endpoint: 'https://reviewed-resource.openai.azure.com/openai/v1', imageInput: false })
    expect(stored.encryptedCredential).not.toContain('azure-write-only-secret')
    const audit = (await payload.find({ collection: 'audit-events', where: { event: { equals: 'integration.credential_rotated' } }, overrideAccess: true })).docs.find((item: any) => item.detail?.provider === 'azure-openai')
    if (audit) await payload.delete({ collection: 'audit-events', id: audit.id, overrideAccess: true })
    await payload.delete({ collection: 'integration-configurations', id: stored.id, overrideAccess: true })
  })

  it('rolls back the route service when its required audit write fails', async () => {
    const pricing = { monthlyCapMicroUsd: null, inputMicroUsdPerMillionTokens: 1_000_000, outputMicroUsdPerMillionTokens: 2_000_000, pricingSource: 'https://prices.example.test/review', pricingAsOf: '2026-10-04T00:00:00.000Z' }
    await configureIntegration(payload, { provider: 'anthropic', model: 'stable-model', credential: 'stable-credential', fallbackProvider: null, pricing }, async ({ payload, req, event, actor, provider }) => {
      await payload.create({ collection: 'audit-events', data: { event, actor, detail: { provider } }, overrideAccess: true, req: req as never })
    })
    const before = (await payload.find({ collection: 'integration-configurations', where: { provider: { equals: 'anthropic' } }, overrideAccess: true })).docs[0]!
    await expect(configureIntegration(payload, { provider: 'anthropic', model: 'changed-model', credential: 'changed-credential', fallbackProvider: null, pricing }, async () => { throw new Error('injected audit write failure') })).rejects.toThrow('injected audit write failure')
    const after = (await payload.find({ collection: 'integration-configurations', where: { provider: { equals: 'anthropic' } }, overrideAccess: true })).docs[0]!
    expect(after.model).toBe('stable-model')
    expect(after.encryptedCredential).toBe(before.encryptedCredential)
    await expect(payload.count({ collection: 'audit-events', where: { event: { equals: 'integration.credential_rotated' } }, overrideAccess: true })).resolves.toMatchObject({ totalDocs: 1 })
  })

  it('persists only a normalized explicit test result and redacted audit metadata', async () => {
    const pricing = { monthlyCapMicroUsd: null, inputMicroUsdPerMillionTokens: 1_000_000, outputMicroUsdPerMillionTokens: 2_000_000, pricingSource: 'https://prices.example.test/review', pricingAsOf: '2026-10-04T00:00:00.000Z' }
    const owner = await payload.create({ collection: 'users', data: { email: 'connection-owner@example.test', name: 'Connection owner', roles: ['owner'] }, overrideAccess: true })
    await configureIntegration(payload, { provider: 'openai', model: 'test-model', credential: 'never-in-audit', fallbackProvider: null, pricing, actor: owner.id })
    const saved = await testIntegrationConnection(payload, { provider: 'openai', actor: owner.id, now: new Date('2026-10-04T01:00:00.000Z') }, async ({ credential }) => {
      expect(credential).toBe('never-in-audit')
      return { ok: true, code: 'connected' }
    })
    expect(saved).toMatchObject({ health: 'connected', testedAt: '2026-10-04T01:00:00.000Z' })
    const audit = (await payload.find({ collection: 'audit-events', where: { event: { equals: 'integration.connection_tested' } }, overrideAccess: true })).docs[0]!
    expect(audit).toMatchObject({ event: 'integration.connection_tested', actor: { id: owner.id }, detail: { provider: 'openai', health: 'connected' } })
    expect(JSON.stringify(audit)).not.toContain('never-in-audit')
  })

  it('queues one Owner outage alert only for a connected integration transition and allows a later restored transition', async () => {
    const pricing = { monthlyCapMicroUsd: null, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 2, pricingSource: 'https://prices.example.test/review', pricingAsOf: '2026-10-04T00:00:00.000Z' }
    const owner = await payload.create({ collection: 'users', data: { email: 'outage-owner@example.test', name: 'Outage owner', roles: ['owner'] }, overrideAccess: true })
    await configureIntegration(payload, { provider: 'openrouter', model: 'provider/model', credential: 'outage-secret', fallbackProvider: null, pricing, actor: owner.id })
    await testIntegrationConnection(payload, { provider: 'openrouter', actor: owner.id, now: new Date('2026-10-04T01:00:00.000Z') }, async () => ({ ok: true, code: 'connected' }))
    await testIntegrationConnection(payload, { provider: 'openrouter', actor: owner.id, now: new Date('2026-10-04T02:00:00.000Z') }, async () => ({ ok: false, code: 'unavailable' }))
    await testIntegrationConnection(payload, { provider: 'openrouter', actor: owner.id, now: new Date('2026-10-04T03:00:00.000Z') }, async () => ({ ok: false, code: 'unavailable' }))
    let alerts = await payload.find({ collection: 'notification-outbox', where: { sourceType: { equals: 'integration-configuration' } }, limit: 10, depth: 0, overrideAccess: true })
    expect(alerts.totalDocs).toBe(1); expect(alerts.docs[0]).toMatchObject({ kind: 'publish-or-integration-failed', recipientRules: ['owner'], payload: expect.objectContaining({ provider: 'openrouter', health: 'unavailable' }) })
    const audit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'integration.outage' } }, limit: 10, depth: 0, overrideAccess: true })
    expect(audit.totalDocs).toBe(1); expect(JSON.stringify(audit.docs[0])).not.toContain('outage-secret')
    await testIntegrationConnection(payload, { provider: 'openrouter', actor: owner.id, now: new Date('2026-10-04T04:00:00.000Z') }, async () => ({ ok: true, code: 'connected' }))
    await testIntegrationConnection(payload, { provider: 'openrouter', actor: owner.id, now: new Date('2026-10-04T05:00:00.000Z') }, async () => ({ ok: false, code: 'rejected' }))
    alerts = await payload.find({ collection: 'notification-outbox', where: { sourceType: { equals: 'integration-configuration' } }, limit: 10, depth: 0, overrideAccess: true })
    expect(alerts.totalDocs).toBe(2)
  })

  it('runs a bounded configured-only monitor and creates the same durable outage intent', async () => {
    const pricing = { monthlyCapMicroUsd: null, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 2, pricingSource: 'https://prices.example.test/review', pricingAsOf: '2026-10-04T00:00:00.000Z' }
    await configureIntegration(payload, { provider: 'google-gemini', model: 'monitor-model', credential: 'monitor-secret', fallbackProvider: null, pricing })
    await testIntegrationConnection(payload, { provider: 'google-gemini', now: new Date('2026-10-04T00:00:00.000Z') }, async () => ({ ok: true, code: 'connected' }))
    expect(await monitorIntegrationHealth(payload, new Date('2026-10-04T00:05:00.000Z'), async () => ({ ok: false, code: 'unavailable' }))).toBeGreaterThanOrEqual(1)
    const alerts = await payload.find({ collection: 'notification-outbox', where: { sourceType: { equals: 'integration-configuration' } }, limit: 100, depth: 0, overrideAccess: true })
    expect(alerts.docs.some(item => (item.payload as Record<string, unknown>)?.provider === 'google-gemini')).toBe(true)
    await revokeIntegration(payload, { provider: 'google-gemini' })
    const probed: string[] = []
    await monitorIntegrationHealth(payload, new Date('2026-10-04T01:00:00.000Z'), async ({ provider }) => { probed.push(provider); return { ok: false, code: 'unavailable' } })
    expect(probed).not.toContain('google-gemini')
  })

  it('fails closed when a configuration rotates or is revoked during the external check', async () => {
    const pricing = { monthlyCapMicroUsd: null, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 2, pricingSource: 'https://prices.example.test/review', pricingAsOf: '2026-10-04T00:00:00.000Z' }
    await configureIntegration(payload, { provider: 'google-gemini', model: 'old-model', credential: 'old-credential', fallbackProvider: null, pricing })
    await expect(testIntegrationConnection(payload, { provider: 'google-gemini' }, async () => {
      await configureIntegration(payload, { provider: 'google-gemini', model: 'new-model', credential: 'new-credential', fallbackProvider: null, pricing })
      return { ok: true, code: 'connected' }
    })).rejects.toThrow('INTEGRATION_CONFIGURATION_STALE')
    const rotated = (await payload.find({ collection: 'integration-configurations', where: { provider: { equals: 'google-gemini' } }, overrideAccess: true })).docs[0]!
    expect(rotated).toMatchObject({ model: 'new-model', health: 'unknown' })

    await configureIntegration(payload, { provider: 'openrouter', model: 'vendor/model', credential: 'temporary', fallbackProvider: null, pricing })
    await expect(testIntegrationConnection(payload, { provider: 'openrouter' }, async () => {
      await revokeIntegration(payload, { provider: 'openrouter' })
      return { ok: true, code: 'connected' }
    })).rejects.toThrow('INTEGRATION_CONFIGURATION_STALE')
    const revoked = (await payload.find({ collection: 'integration-configurations', where: { provider: { equals: 'openrouter' } }, overrideAccess: true })).docs[0]!
    expect(revoked).toMatchObject({ health: 'revoked', encryptedCredential: null })
  })

  it('rolls back normalized health when its mandatory audit write fails', async () => {
    const pricing = { monthlyCapMicroUsd: null, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 2, pricingSource: 'https://prices.example.test/review', pricingAsOf: '2026-10-04T00:00:00.000Z' }
    await configureIntegration(payload, { provider: 'anthropic', model: 'stable-model', credential: 'stable-credential', fallbackProvider: null, pricing })
    await expect(testIntegrationConnection(payload, { provider: 'anthropic' }, async () => ({ ok: true, code: 'connected' }), async () => { throw new Error('audit required') })).rejects.toThrow('audit required')
    const saved = (await payload.find({ collection: 'integration-configurations', where: { provider: { equals: 'anthropic' } }, overrideAccess: true })).docs.find(item => item.model === 'stable-model')!
    expect(saved).toMatchObject({ health: 'unknown', testedAt: null })
  })

  it('requires same-origin fresh Owner intent and returns a redacted test response', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'route-owner@example.test', name: 'Route owner', roles: ['owner'] }, overrideAccess: true })
    const session = await freshSession(owner.id)
    const request = (headers: Record<string, string>) => integrationRoute.POST(new Request('http://cms.test/api/integrations', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action: 'test', provider: 'openai', credential: 'ignored-client-value' }) }))
    await expect(request({ origin: 'http://cms.test' })).resolves.toMatchObject({ status: 403 })
    await expect(request({ cookie: session })).resolves.toMatchObject({ status: 403 })
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response('provider-secret', { status: 200 }) }) as typeof fetch
    try {
      const response = await request({ origin: 'http://cms.test', cookie: session })
      expect(response.status).toBe(200)
      const body = await response.json() as Record<string, unknown>
      expect(JSON.stringify(body)).not.toContain('provider-secret')
      expect(JSON.stringify(body)).not.toContain('never-in-audit')
      expect(body).toMatchObject({ integration: { provider: 'openai', health: 'connected', credentialConfigured: true } })
      expect(calls).toBe(1)
      const oversized = await integrationRoute.POST(new Request('http://cms.test/api/integrations', { method: 'POST', headers: { origin: 'http://cms.test', 'content-type': 'application/json', cookie: session }, body: JSON.stringify({ action: 'test', provider: 'openai', padding: 'x'.repeat(25 * 1024) }) }))
      expect(oversized.status).toBe(400)
      expect(calls).toBe(1)
    } finally { globalThis.fetch = originalFetch }
  })

  it("rejects self-fallback configuration requests before writing state and accepts distinct fallbacks", async () => {
    const owner = await payload.create({ collection: "users", data: { email: "fallback-route-owner@example.test", name: "Fallback route owner", roles: ["owner"] }, overrideAccess: true })
    const session = await freshSession(owner.id)
    const editor = await payload.create({ collection: "users", data: { email: "fallback-route-editor@example.test", name: "Fallback route editor", roles: ["editor"] }, overrideAccess: true })
    const editorSession = await freshSession(editor.id)
    const request = (body: Record<string, unknown>) => integrationRoute.POST(new Request("http://cms.test/api/integrations", { method: "POST", headers: { origin: "http://cms.test", cookie: session, "content-type": "application/json" }, body: JSON.stringify(body) }))
    const pricing = { monthlyCapMicroUsd: null, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 2, pricingSource: "https://prices.example.test/review", pricingAsOf: "2026-10-04T00:00:00.000Z" }
    await configureIntegration(payload, { provider: "anthropic", model: "fallback-model", credential: "fallback-route-secret", fallbackProvider: null, pricing, actor: owner.id })
    const before = {
      configurations: JSON.stringify((await payload.find({ collection: "integration-configurations", sort: "provider", overrideAccess: true })).docs),
      defaults: JSON.stringify((await payload.find({ collection: "ai-job-defaults", sort: "jobType", overrideAccess: true })).docs),
      jobs: (await payload.count({ collection: "configured-ai-jobs", overrideAccess: true })).totalDocs,
      audits: (await payload.count({ collection: "audit-events", overrideAccess: true })).totalDocs,
    }
    const configure = { action: "configure", provider: "google-gemini", model: "route-model", credential: "route-secret", fallbackProvider: "google-gemini", ...pricing }
    const aiDefault = { action: "configure-ai-default", provider: "anthropic", model: "fallback-model", jobType: "summary", fallbackProvider: "anthropic" }
    expect((await request(configure)).status).toBe(400)
    expect((await request(aiDefault)).status).toBe(400)
    const denied = await integrationRoute.POST(new Request("http://cms.test/api/integrations", { method: "POST", headers: { origin: "http://cms.test", cookie: editorSession, "content-type": "application/json" }, body: JSON.stringify({ ...configure, fallbackProvider: "anthropic" }) }))
    expect(denied.status).toBe(403)
    expect(JSON.stringify((await payload.find({ collection: "integration-configurations", sort: "provider", overrideAccess: true })).docs)).toBe(before.configurations)
    expect(JSON.stringify((await payload.find({ collection: "ai-job-defaults", sort: "jobType", overrideAccess: true })).docs)).toBe(before.defaults)
    expect((await payload.count({ collection: "configured-ai-jobs", overrideAccess: true })).totalDocs).toBe(before.jobs)
    expect((await payload.count({ collection: "audit-events", overrideAccess: true })).totalDocs).toBe(before.audits)
    await expect(configureIntegration(payload, { ...configure, pricing } as never)).rejects.toThrow("INTEGRATION_FALLBACK_SELF")
    expect((await payload.count({ collection: "audit-events", overrideAccess: true })).totalDocs).toBe(before.audits)
    const valid = await request({ ...configure, fallbackProvider: "anthropic" })
    expect([200, 201]).toContain(valid.status)
    const configured = (await payload.find({ collection: "integration-configurations", where: { provider: { equals: "google-gemini" } }, limit: 1, overrideAccess: true })).docs[0]!
    expect(configured).toMatchObject({ provider: "google-gemini", fallbackProvider: "anthropic" })
    const routed = await request({ ...aiDefault, provider: "google-gemini", model: "route-model", fallbackProvider: "anthropic" })
    expect(routed.status).toBe(200)
    await expect(routed.json()).resolves.toMatchObject({ aiJobDefault: { provider: "google-gemini", fallbackProvider: "anthropic" } })
  })

  it("records redacted credential rotation and revocation audit metadata", async () => {
    const owner = await payload.create({ collection: "users", data: { email: "credential-audit-owner@example.test", name: "Credential audit owner", roles: ["owner"] }, overrideAccess: true })
    const pricing = { monthlyCapMicroUsd: null, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 2, pricingSource: "https://prices.example.test/review", pricingAsOf: "2026-10-04T00:00:00.000Z" }
    const secret = "credential-lifecycle-secret"
    const configured = await configureIntegration(payload, { provider: "openai", model: "credential-audit-model", credential: secret, fallbackProvider: null, pricing, actor: owner.id })
    const rotation = (await payload.find({ collection: "audit-events", where: { event: { equals: "integration.credential_rotated" } }, sort: "-createdAt", limit: 1, overrideAccess: true })).docs[0]!
    expect(rotation).toMatchObject({ event: "integration.credential_rotated", actor: { id: owner.id }, detail: { provider: "openai" } })
    expect(Number.isFinite(Date.parse(rotation.createdAt))).toBe(true)
    const rotationDetail = JSON.stringify(rotation.detail)
    expect(rotationDetail).not.toContain(secret)
    expect(rotationDetail).not.toContain(String(configured.saved.encryptedCredential))
    expect(rotationDetail).not.toContain(String(configured.saved.credentialFingerprint))
    await revokeIntegration(payload, { provider: "openai", actor: owner.id })
    const revocation = (await payload.find({ collection: "audit-events", where: { event: { equals: "integration.credential_revoked" } }, sort: "-createdAt", limit: 1, overrideAccess: true })).docs[0]!
    expect(revocation).toMatchObject({ event: "integration.credential_revoked", actor: { id: owner.id }, detail: { provider: "openai" } })
    expect(Number.isFinite(Date.parse(revocation.createdAt))).toBe(true)
    const revocationDetail = JSON.stringify(revocation.detail)
    expect(revocationDetail).not.toContain(secret)
    expect(revocationDetail).not.toContain(String(configured.saved.encryptedCredential))
    expect(revocationDetail).not.toContain(String(configured.saved.credentialFingerprint))
  })
})
