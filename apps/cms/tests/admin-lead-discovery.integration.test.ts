import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { navigationBadges } from '../src/admin-navigation'
import { searchAdminRecords } from '../src/admin-search'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-admin-lead-discovery-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'admin-lead-discovery-secret-that-is-long-enough'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => { payload = await getPayload({ config }) }, 60_000)
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

const inquiry = (name: string, spam: boolean | null) => payload.create({
  collection: 'inquiries',
  data: { name, company: name, email: `${name}@example.test`, message: 'Synthetic lead.', topic: 'general', sourcePage: '/contact', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: `discovery-${name}`, stage: 'new', urgent: false, spam },
  overrideAccess: true,
})

describe('admin lead discovery', () => {
  it('counts and searches active and legacy leads while excluding quarantined spam', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'lead-discovery-owner@example.test', name: 'Lead Discovery Owner', roles: ['owner'] }, overrideAccess: true })
    await inquiry('active-discovery', false)
    await inquiry('legacy-discovery', null)
    await inquiry('spam-discovery', true)

    await expect(navigationBadges(payload, owner)).resolves.toMatchObject({ Leads: 2 })
    await expect(searchAdminRecords(payload, owner, 'active-discovery')).resolves.toMatchObject({ results: { Leads: [{ title: 'active-discovery' }] } })
    await expect(searchAdminRecords(payload, owner, 'legacy-discovery')).resolves.toMatchObject({ results: { Leads: [{ title: 'legacy-discovery' }] } })
    await expect(searchAdminRecords(payload, owner, 'spam-discovery')).resolves.toMatchObject({ results: { Leads: [] } })
  })
})
