import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPayload } from 'payload'
import { neutralFixture } from '@site-engine/contract/fixtures'

const directory = mkdtempSync(join(tmpdir(), 'application-intake-route-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.APPLICATION_STORAGE_DIR = join(directory, 'applications')
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-payload'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'https://cms.example.test'
const { default: config } = await import('../payload.config.js')
const { POST } = await import('../app/api/applications/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>
let jobID = ''; let closedJobID = ''

beforeAll(async () => {
  payload = await getPayload({ config })
  const owner = await payload.create({ collection: 'users', data: { email: 'application-route-owner@example.test', name: 'Application route owner', roles: ['owner'] }, overrideAccess: true })
  jobID = randomUUID(); closedJobID = randomUUID()
  const manifest = structuredClone(neutralFixture); const section = manifest.settings.sections[0]!
  section.allowedTemplates.push('job'); section.pageIds.push(jobID, closedJobID)
  manifest.pages.push({ id: jobID, sectionId: section.id, title: 'Open role', summary: 'A route verification role.', slug: 'open-role', template: 'job', status: 'published', blocks: [], jobPosting: { datePosted: '2026-10-01T00:00:00.000Z', employmentType: 'FULL_TIME', location: { addressLocality: 'Example City', addressCountry: 'CA' } } })
  manifest.pages.push({ id: closedJobID, sectionId: section.id, title: 'Closed role', summary: 'A closed route verification role.', slug: 'closed-role', template: 'job', status: 'published', blocks: [], jobPosting: { datePosted: '2026-10-01T00:00:00.000Z', validThrough: '2020-01-01T00:00:00.000Z', employmentType: 'FULL_TIME', location: { addressLocality: 'Example City', addressCountry: 'CA' } } })
  const set = await payload.create({ collection: 'change-sets', data: { name: 'Application intake route', actor: owner.id, state: 'published', revision: 1, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
  const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: randomUUID(), changeSet: set.id, reviewRevision: 1, changeHash: randomUUID(), manifest, themeVersion: '1.0.0', engineVersion: 'test', contractVersion: manifest.settings.contractVersion, approvedBy: owner.id, baselineSequence: 0 }, overrideAccess: true, context: { editorialInternal: true } })
  const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: randomUUID(), sequence: 1, snapshot: snapshot.id, changeSet: set.id, reviewRevision: 1, changeHash: snapshot.changeHash, includedChangeKeys: [], status: 'completed', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence: 1, snapshot: snapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { checks: [] }, artifact: { digest: 'a'.repeat(64), sourceContentHash: snapshot.contentHash, themeVersion: '1.0.0', engineVersion: 'test', contractVersion: manifest.settings.contractVersion, checks: [] } }, overrideAccess: true, context: { editorialInternal: true } })
}, 60_000)

afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

test('accepts and idempotently preserves an empty optional note through the public route', async () => {
  const key = randomUUID()
  const request = (target = jobID, idempotencyKey = key) => { const form = new FormData(); form.set('name', 'Empty note applicant'); form.set('email', 'empty-note@example.test'); form.set('coverLetter', ''); form.set('consent', 'true'); form.set('jobId', target); form.set('idempotencyKey', idempotencyKey); form.set('resume', new File([Buffer.from('%PDF-1.7\nresume\n%%EOF')], 'resume.pdf', { type: 'application/pdf' })); return new Request('https://cms.example.test/api/applications', { method: 'POST', headers: { origin: 'https://cms.example.test' }, body: form }) }
  const created = await POST(request()); expect(created.status).toBe(201); const body = await created.json() as { id: string }
  expect((await payload.findByID({ collection: 'applications', id: body.id, overrideAccess: true })).coverLetter).toBe('')
  const retry = await POST(request()); expect(retry.status).toBe(200); await expect(retry.json()).resolves.toEqual({ id: body.id })
  expect((await POST(request(closedJobID, randomUUID()))).status).toBe(400)
  expect((await payload.find({ collection: 'applications', overrideAccess: true, limit: 0 })).totalDocs).toBe(1)
}, 60_000)
