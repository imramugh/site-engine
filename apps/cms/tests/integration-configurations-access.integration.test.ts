import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { configureIntegration, revokeIntegration, testIntegrationConnection } from '../src/integration-configuration'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-integration-access-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-integration-access'
process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64url')
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
  it('denies direct owner CRUD so credential changes can only use the audited route', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'integration-owner@example.test', name: 'Integration owner', roles: ['owner'] }, overrideAccess: true })
    const data = { provider: 'openai' as const, model: 'synthetic-model', health: 'unknown' as const }
    await expect(payload.create({ collection: 'integration-configurations', data, user: owner, overrideAccess: false })).rejects.toThrow()
    await expect(payload.find({ collection: 'integration-configurations', user: owner, overrideAccess: false })).rejects.toThrow()
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
})
