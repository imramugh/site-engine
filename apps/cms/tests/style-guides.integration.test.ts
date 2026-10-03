import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { checkSiteSnapshot } from '@site-engine/checks'
import { buildCandidate } from '../src/publishing'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-style-guides-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-reviewed-style-guides'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

describe('reviewed style guide singleton', () => {
  it('lets an Owner freeze a guide into a candidate while Editor writes remain denied and warnings stay non-blocking', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `style-owner-${randomUUID()}@example.test`, name: 'Style owner', roles: ['owner'] }, overrideAccess: true })
    const editor = await payload.create({ collection: 'users', data: { email: `style-editor-${randomUUID()}@example.test`, name: 'Style editor', roles: ['editor'] }, overrideAccess: true })
    const guide = await payload.create({ collection: 'style-guides', data: { bannedPhrases: ['placeholder phrase'], preferredTerms: [{ avoid: 'color', prefer: 'colour' }], canadianSpelling: 'warn', maximumSentenceWords: 30, minimumReadingEase: 30 }, draft: true, user: owner, overrideAccess: false })
    await expect(payload.update({ collection: 'style-guides', id: guide.id, data: { canadianSpelling: 'off' }, user: editor, overrideAccess: false })).rejects.toThrow()
    const set = await payload.find({ collection: 'change-sets', where: { actor: { equals: owner.id } }, depth: 0, overrideAccess: true })
    const change = (set.docs[0]!.changes as Array<{ collection: string; id: string }>).find((item) => item.collection === 'style-guides')!
    const base = structuredClone(neutralFixture)
    // Capture the exact reviewed change before a later mutable save. The
    // candidate and its readiness input must never follow that later save.
    const frozenChange = structuredClone(change)
    const candidate = buildCandidate(base, [frozenChange] as never, [`style-guides:${change.id}`], { themeVersion: '1.0.0', engineVersion: '1.0.0', contractVersion: '1.0.0' })
    expect(candidate.styleGuide).toMatchObject({ bannedPhrases: ['placeholder phrase'], preferredTerms: [{ avoid: 'color', prefer: 'colour' }], canadianSpelling: 'warn' })
    expect(base.styleGuide).toBeUndefined()
    const hero = candidate.pages[0]!.blocks[0]!; if (hero.type === 'hero') hero.body = 'A placeholder phrase with color.'
    const report = checkSiteSnapshot(candidate, { style: candidate.styleGuide })
    expect(report.publishable).toBe(true)
    expect(report.warnings.map((item) => item.code)).toEqual(expect.arrayContaining(['STYLE_BANNED_PHRASE', 'STYLE_PREFERRED_TERM', 'STYLE_CANADIAN_SPELLING']))
    const frozenProof = structuredClone({ styleGuide: candidate.styleGuide, warnings: report.warnings.map((item) => item.code).sort() })
    await payload.update({ collection: 'style-guides', id: guide.id, data: { bannedPhrases: ['later mutable phrase'], canadianSpelling: 'off' }, draft: true, user: owner, overrideAccess: false })
    const repeated = checkSiteSnapshot(candidate, { style: candidate.styleGuide })
    expect({ styleGuide: candidate.styleGuide, warnings: repeated.warnings.map((item) => item.code).sort() }).toEqual(frozenProof)
    expect(candidate.styleGuide).toMatchObject({ bannedPhrases: ['placeholder phrase'], canadianSpelling: 'warn' })
  })
})
