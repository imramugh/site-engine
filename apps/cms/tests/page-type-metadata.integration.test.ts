import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { getPayload } from 'payload'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-page-metadata-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-page-metadata'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE = join(directory, 'bootstrap-token')
writeFileSync(process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE, 'test-only-bootstrap-token')
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => { payload = await getPayload({ config }) }, 30_000)
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

async function section(templates: Array<'pillar' | 'service' | 'article' | 'job'>) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
  return payload.create({ collection: 'sections', data: { name: `Metadata ${suffix}`, slug: `metadata-${suffix}`, allowedTemplates: templates }, overrideAccess: true, context: { editorialInternal: true } })
}

const common = (sectionId: string, template: 'pillar' | 'service' | 'article' | 'job') => ({
  title: `${template} metadata`, summary: 'A sufficiently descriptive summary for metadata persistence.',
  slug: `${template}-${randomUUID().replaceAll('-', '').slice(0, 8)}`, sectionId, template, blocks: [],
})

describe('ENG-006 page type metadata persistence', () => {
  it('persists service introduction and review metadata', async () => {
    const parent = await section(['service', 'pillar'])
    const pillar = await payload.create({ collection: 'pages', data: { ...common(parent.id, 'pillar'), title: 'Service pillar' }, overrideAccess: true, context: { editorialInternal: true } })
    const page = await payload.create({ collection: 'pages', data: { ...common(parent.id, 'service'), parentId: pillar.id, kicker: 'Advisory', lede: 'A durable service introduction.', lastReviewed: '2026-10-01T00:00:00.000Z' }, overrideAccess: true, context: { editorialInternal: true } })
    expect(page).toMatchObject({ kicker: 'Advisory', lede: 'A durable service introduction.', lastReviewed: '2026-10-01T00:00:00.000Z' })
  })

  it('persists article publication and business-case metadata', async () => {
    const parent = await section(['article'])
    const businessCase = { anonymizedClient: 'Regional organization', industry: 'Services', challenge: 'A clear challenge.', approach: 'A clear approach.', outcome: 'A clear outcome.', services: ['Advisory'], publicationDate: '2026-09-30T00:00:00.000Z' }
    const page = await payload.create({ collection: 'pages', data: { ...common(parent.id, 'article'), publishedAt: '2026-09-29T00:00:00.000Z', lastReviewed: '2026-10-01T00:00:00.000Z', businessCase }, overrideAccess: true, context: { editorialInternal: true } })
    expect(page).toMatchObject({ publishedAt: '2026-09-29T00:00:00.000Z', lastReviewed: '2026-10-01T00:00:00.000Z', businessCase })
  })

  it('persists supported job metadata and rejects it on another template', async () => {
    const parent = await section(['job', 'article'])
    const jobPosting = { datePosted: '2026-10-01T00:00:00.000Z', employmentType: 'FULL_TIME' as const, workMode: 'HYBRID' as const, location: { addressLocality: 'Example City', addressRegion: 'Region', addressCountry: 'CA' }, validThrough: '2026-11-01T00:00:00.000Z' }
    const page = await payload.create({ collection: 'pages', data: { ...common(parent.id, 'job'), jobPosting }, overrideAccess: true, context: { editorialInternal: true } })
    expect(page).toMatchObject({ jobPosting })
    await expect(payload.create({ collection: 'pages', data: { ...common(parent.id, 'article'), jobPosting }, overrideAccess: true, context: { editorialInternal: true } })).rejects.toThrow(/jobPosting/)
  })
})
