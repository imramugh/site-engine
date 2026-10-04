import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { getAdminDashboardData } from '../src/admin-dashboard'
import { createAcceptedInquiry, validateInquiry } from '../src/inquiries'
import { neutralFixture } from '@site-engine/contract/fixtures'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-admin-dashboard-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'admin-dashboard-integration-secret-that-is-long-enough'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

function observedPayload(collections: string[], calls: any[] = []) {
  return {
    count: (args: any) => { collections.push(args.collection); calls.push(args); return payload.count(args) },
    find: (args: any) => { collections.push(args.collection); calls.push(args); return payload.find(args) },
  }
}

describe('ENG-022 dashboard aggregates (ENG-006 access controls)', () => {
  it('reports real submitted-review and lead queue counts to an owner', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'dashboard-owner@example.test', name: 'Dashboard Owner', roles: ['owner'] }, overrideAccess: true })
    await payload.create({ collection: 'change-sets', data: { name: 'Ready for review', state: 'submitted', revision: 1, changes: [] }, context: { editorialInternal: true }, overrideAccess: true })
    await payload.create({ collection: 'change-sets', data: { name: 'Blocked review', state: 'submitted', revision: 1, changes: [], quality: { checks: [{ name: 'contract-and-tree', status: 'failed' }] } }, context: { editorialInternal: true }, overrideAccess: true })
    await createAcceptedInquiry(payload, validateInquiry({ email: 'urgent-dashboard@example.test', message: 'An active incident needs attention.', topic: 'active-incident', sourcePage: '/contact', consent: true, idempotencyKey: 'urgent-dashboard-idempotency-key' }).input!)
    await createAcceptedInquiry(payload, validateInquiry({ email: 'standard-dashboard@example.test', message: 'A new project inquiry needs attention.', topic: 'project', sourcePage: '/contact', consent: true, idempotencyKey: 'standard-dashboard-idempotency-key' }).input!)

    const set = (await payload.find({ collection: 'change-sets', where: { name: { equals: 'Ready for review' } }, overrideAccess: true })).docs[0]!
    const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: 'a'.repeat(64), changeSet: set.id, reviewRevision: 1, changeHash: 'b'.repeat(64), manifest: neutralFixture, themeVersion: '1.0.0', engineVersion: 'test', contractVersion: '1.0.0', approvedBy: owner.id, baselineSequence: 0 }, overrideAccess: true, context: { editorialInternal: true } })
    const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: 'dashboard-release-outbox-key', sequence: 1, snapshot: snapshot.id, changeSet: set.id, reviewRevision: 1, changeHash: 'b'.repeat(64), includedChangeKeys: [], status: 'completed', attempts: 1, correlationID: 'dashboard-release-correlation' }, overrideAccess: true, context: { editorialInternal: true } })
    const activatedAt = '2026-10-04T12:00:00.000Z'
    await payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence: 1, snapshot: snapshot.id, activatedAt, healthEvidence: { status: 'healthy' }, artifact: { digest: 'c'.repeat(64), sourceContentHash: snapshot.contentHash, themeVersion: '1.0.0', engineVersion: 'test', contractVersion: '1.0.0', checks: [] } }, overrideAccess: true, context: { editorialInternal: true } })

    const result = await getAdminDashboardData(observedPayload([]), owner)
    expect(result).toMatchObject({ state: 'ready', pendingReviews: { total: 2 }, pages: { readiness: { state: 'available', issues: 0 }, withIssues: { state: 'available' } }, leads: { new: 2, urgent: 1 }, latestRelease: { sequence: 1, activatedAt } })
    expect(result.pendingReviews?.items.find((item) => item.name === 'Ready for review')).toMatchObject({ readiness: 'not-run', issues: 0 })
    expect(result.pendingReviews?.items.find((item) => item.name === 'Blocked review')).toMatchObject({ readiness: 'blocked', issues: 0 })
    expect(result.leads?.items).toHaveLength(2)
    expect(JSON.stringify(result.leads)).not.toContain('active incident needs attention')
    expect(result.actions.map((item) => item.href)).toContain('/integrations')
    expect(result.shortcuts.map((item) => item.href)).toContain('/leads')
  })

  it('does not query or return private lead data for an editor or approver', async () => {
    const editor = await payload.create({ collection: 'users', data: { email: 'dashboard-editor@example.test', name: 'Dashboard Editor', roles: ['editor'] }, overrideAccess: true })
    const approver = await payload.create({ collection: 'users', data: { email: 'dashboard-approver@example.test', name: 'Dashboard Approver', roles: ['approver'] }, overrideAccess: true })

    for (const actor of [editor, approver]) {
      const collections: string[] = []
      const result = await getAdminDashboardData(observedPayload(collections), actor)
      expect(result.leads).toBeUndefined()
      expect(result.providers).toBeUndefined()
      expect(collections).not.toContain('inquiries')
      expect(collections).not.toContain('integration-configurations')
      expect(result.shortcuts.map((item) => item.href)).not.toContain('/leads')
      expect(result.shortcuts.map((item) => item.href)).not.toContain('/applications')
    }
  })

  it('denies unauthorised roles without reading any collection', async () => {
    const collections: string[] = []
    const result = await getAdminDashboardData(observedPayload(collections), { id: 'no-role', roles: [], disabled: false })
    expect(result).toMatchObject({ state: 'error', shortcuts: [] })
    expect(collections).toEqual([])
  })

  it('limits Sales to lead aggregates and gives Hiring no private aggregate data', async () => {
    const sales = await payload.create({ collection: 'users', data: { email: 'dashboard-sales@example.test', name: 'Dashboard Sales', roles: ['sales'] }, overrideAccess: true })
    const hiring = await payload.create({ collection: 'users', data: { email: 'dashboard-hiring@example.test', name: 'Dashboard Hiring', roles: ['hiring'] }, overrideAccess: true })
    const salesCollections: string[] = []
    const salesResult = await getAdminDashboardData(observedPayload(salesCollections), sales)
    expect(salesResult.leads).toMatchObject({ new: 2, urgent: 1 })
    expect(salesCollections).toEqual(['inquiries', 'inquiries', 'inquiries'])
    expect(salesResult.actions).toEqual([])
    expect(salesResult.shortcuts.map((item) => item.href)).toEqual(['/leads'])
    const hiringCollections: string[] = []
    const hiringResult = await getAdminDashboardData(observedPayload(hiringCollections), hiring)
    expect(hiringCollections).toEqual([])
    expect(hiringResult.leads).toBeUndefined()
    expect(hiringResult.actions).toEqual([])
    expect(hiringResult.shortcuts.map((item) => item.href)).toEqual(['/applications'])
  })

  it('denies a disabled user without reading any collection', async () => {
    const collections: string[] = []
    const result = await getAdminDashboardData(observedPayload(collections), { id: 'disabled', roles: ['owner'], disabled: true })
    expect(result.state).toBe('error')
    expect(collections).toEqual([])
  })
})

describe('dashboard read-model regressions', () => {
  it('projects owner provider health without credentials', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'provider-owner@example.test', name: 'Provider Owner', roles: ['owner'] }, overrideAccess: true })
    await payload.create({ collection: 'integration-configurations', data: { provider: 'openai', model: 'gpt-test', encryptedCredential: 'secret-test-marker', credentialFingerprint: 'abc', health: 'connected', testedAt: '2026-10-04T12:00:00.000Z' }, overrideAccess: true })
    const collections: string[] = []; const calls: any[] = []
    const result = await getAdminDashboardData(observedPayload(collections, calls), owner)
    expect(result.providers).toMatchObject({ configured: 1, connected: 1, testedAt: '2026-10-04T12:00:00.000Z' })
    expect(JSON.stringify(result)).not.toContain('secret-test-marker')
    const providerQuery = calls.find((call) => call.collection === 'integration-configurations')
    expect(providerQuery?.select).toEqual({ provider: true, health: true, testedAt: true })
  })

  it('counts distinct published pages with multiple recorded issues', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'issues-owner@example.test', name: 'Issues Owner', roles: ['owner'] }, overrideAccess: true })
    const set = await payload.create({ collection: 'change-sets', data: { name: 'issues fixture', state: 'submitted', revision: 1, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
    const manifest = structuredClone(neutralFixture); const page = manifest.pages[0]!; page.seoDescription = 'short'; page.summary = 'short'
    const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: 'd'.repeat(64), changeSet: set.id, reviewRevision: 1, changeHash: 'e'.repeat(64), manifest, themeVersion: '1.0.0', engineVersion: 'test', contractVersion: manifest.settings.contractVersion, approvedBy: owner.id, baselineSequence: 0 }, overrideAccess: true, context: { editorialInternal: true } })
    const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: `issues-${snapshot.id}`, sequence: 99, snapshot: snapshot.id, changeSet: set.id, reviewRevision: 1, changeHash: 'e'.repeat(64), includedChangeKeys: [], status: 'completed', attempts: 1, correlationID: 'issues-correlation' }, overrideAccess: true, context: { editorialInternal: true } })
    await payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence: 99, snapshot: snapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { status: 'healthy' }, artifact: { digest: 'f'.repeat(64), sourceContentHash: snapshot.contentHash, themeVersion: '1.0.0', engineVersion: 'test', contractVersion: manifest.settings.contractVersion, checks: [] } }, overrideAccess: true, context: { editorialInternal: true } })
    const result = await getAdminDashboardData(observedPayload([]), owner)
    expect(result.pages?.withIssues.state).toBe('available'); expect(result.pages?.withIssues.total).toBe(1); expect(result.pages?.withIssues.items[0]?.messages.length).toBeGreaterThan(1)
  })

  it('treats a malformed published snapshot as unavailable rather than an all-clear', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'malformed-owner@example.test', name: 'Malformed Owner', roles: ['owner'] }, overrideAccess: true })
    const set = await payload.create({ collection: 'change-sets', data: { name: 'malformed fixture', state: 'submitted', revision: 1, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
    const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: '1'.repeat(64), changeSet: set.id, reviewRevision: 1, changeHash: '2'.repeat(64), manifest: { pages: 'not-an-array' }, themeVersion: '1.0.0', engineVersion: 'test', contractVersion: '1.0.0', approvedBy: owner.id, baselineSequence: 0 }, overrideAccess: true, context: { editorialInternal: true } })
    const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: `malformed-${snapshot.id}`, sequence: 100, snapshot: snapshot.id, changeSet: set.id, reviewRevision: 1, changeHash: '2'.repeat(64), includedChangeKeys: [], status: 'completed', attempts: 1, correlationID: 'malformed-correlation' }, overrideAccess: true, context: { editorialInternal: true } })
    await payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence: 100, snapshot: snapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { status: 'healthy' }, artifact: { digest: '3'.repeat(64), sourceContentHash: snapshot.contentHash, themeVersion: '1.0.0', engineVersion: 'test', contractVersion: '1.0.0', checks: [] } }, overrideAccess: true, context: { editorialInternal: true } })
    const result = await getAdminDashboardData(observedPayload([]), owner)
    expect(result.state).toBe('ready')
    expect(result.pages?.withIssues).toMatchObject({ state: 'unavailable' })
    expect(result.pages?.withIssues.total).toBeUndefined()
  })

  it('returns no partial private data when an authorized query fails', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'failure-owner@example.test', name: 'Failure Owner', roles: ['owner'] }, overrideAccess: true })
    const broken = { count: payload.count.bind(payload), find: async (args: any) => { if (args.collection === 'inquiries') throw new Error('synthetic failure'); return payload.find(args) } }
    const result = await getAdminDashboardData(broken, owner)
    expect(result).toMatchObject({ state: 'error' }); expect(result.leads).toBeUndefined(); expect(result.providers).toBeUndefined(); expect(result.pages).toBeUndefined()
  })
})
