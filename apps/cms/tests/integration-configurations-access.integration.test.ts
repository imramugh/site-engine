import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { configureIntegration } from '../src/integration-configuration'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-integration-access-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-integration-access'
process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64url')
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

describe('ENG-023 integration configuration access', () => {
  it('denies direct owner CRUD so credential changes can only use the audited route', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'integration-owner@example.test', name: 'Integration owner', roles: ['owner'] }, overrideAccess: true })
    const data = { provider: 'openai' as const, model: 'synthetic-model', health: 'unknown' as const }
    await expect(payload.create({ collection: 'integration-configurations', data, user: owner, overrideAccess: false })).rejects.toThrow()
    await expect(payload.find({ collection: 'integration-configurations', user: owner, overrideAccess: false })).rejects.toThrow()
  })

  it('rolls back the route service when its required audit write fails', async () => {
    await configureIntegration(payload, { provider: 'anthropic', model: 'stable-model', credential: 'stable-credential', fallbackProvider: null, monthlyCap: null }, async ({ payload, req, event, actor, provider }) => {
      await payload.create({ collection: 'audit-events', data: { event, actor, detail: { provider } }, overrideAccess: true, req: req as never })
    })
    const before = (await payload.find({ collection: 'integration-configurations', where: { provider: { equals: 'anthropic' } }, overrideAccess: true })).docs[0]!
    await expect(configureIntegration(payload, { provider: 'anthropic', model: 'changed-model', credential: 'changed-credential', fallbackProvider: null, monthlyCap: null }, async () => { throw new Error('injected audit write failure') })).rejects.toThrow('injected audit write failure')
    const after = (await payload.find({ collection: 'integration-configurations', where: { provider: { equals: 'anthropic' } }, overrideAccess: true })).docs[0]!
    expect(after.model).toBe('stable-model')
    expect(after.encryptedCredential).toBe(before.encryptedCredential)
    await expect(payload.count({ collection: 'audit-events', where: { event: { equals: 'integration.credential_rotated' } }, overrideAccess: true })).resolves.toMatchObject({ totalDocs: 1 })
  })
})
