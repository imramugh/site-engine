import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { getAdminDashboardData } from '../src/admin-dashboard'
import { createAcceptedInquiry, validateInquiry } from '../src/inquiries'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-admin-dashboard-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'admin-dashboard-integration-secret-that-is-long-enough'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

function observedPayload(collections: string[]) {
  return {
    count: (args: any) => { collections.push(args.collection); return payload.count(args) },
    find: (args: any) => { collections.push(args.collection); return payload.find(args) },
  }
}

describe('ENG-022 dashboard aggregates (ENG-006 access controls)', () => {
  it('reports real submitted-review and lead queue counts to an owner', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'dashboard-owner@example.test', name: 'Dashboard Owner', roles: ['owner'] }, overrideAccess: true })
    await payload.create({ collection: 'change-sets', data: { name: 'Ready for review', state: 'submitted', revision: 1, changes: [] }, context: { editorialInternal: true }, overrideAccess: true })
    await createAcceptedInquiry(payload, validateInquiry({ email: 'urgent-dashboard@example.test', message: 'An active incident needs attention.', topic: 'active-incident', sourcePage: '/contact', consent: true, idempotencyKey: 'urgent-dashboard-idempotency-key' }).input!)
    await createAcceptedInquiry(payload, validateInquiry({ email: 'standard-dashboard@example.test', message: 'A new project inquiry needs attention.', topic: 'project', sourcePage: '/contact', consent: true, idempotencyKey: 'standard-dashboard-idempotency-key' }).input!)

    const result = await getAdminDashboardData(observedPayload([]), owner)
    expect(result).toMatchObject({ pendingReviews: 1, pages: { draft: 0 }, leads: { new: 2, urgent: 1 } })
    expect(result.shortcuts.map((item) => item.href)).toContain('/admin/leads')
  })

  it('does not query or return private lead data for an editor or approver', async () => {
    const editor = await payload.create({ collection: 'users', data: { email: 'dashboard-editor@example.test', name: 'Dashboard Editor', roles: ['editor'] }, overrideAccess: true })
    const approver = await payload.create({ collection: 'users', data: { email: 'dashboard-approver@example.test', name: 'Dashboard Approver', roles: ['approver'] }, overrideAccess: true })

    for (const actor of [editor, approver]) {
      const collections: string[] = []
      const result = await getAdminDashboardData(observedPayload(collections), actor)
      expect(result.leads).toBeUndefined()
      expect(collections).not.toContain('inquiries')
      expect(result.shortcuts.map((item) => item.href)).not.toContain('/admin/leads')
      expect(result.shortcuts.map((item) => item.href)).not.toContain('/admin/applications')
    }
  })

  it('denies unauthorised roles without reading any collection', async () => {
    const collections: string[] = []
    const result = await getAdminDashboardData(observedPayload(collections), { id: 'no-role', roles: [], disabled: false })
    expect(result).toMatchObject({ state: 'error', shortcuts: [] })
    expect(collections).toEqual([])
  })
})
