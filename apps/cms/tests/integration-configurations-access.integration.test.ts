import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-integration-access-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-integration-access'
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
})
