import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { artifactName, checkSiteSnapshot, inspectBoundaries, withIsolatedSqlitePath } from '../src/index.js'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { inspectPublicProvenance } from '../src/provenance.js'

const workspaces: string[] = []

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'site-engine-boundaries-'))
  workspaces.push(root)
  for (const [file, contents] of Object.entries(files)) {
    const path = join(root, file)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, contents)
  }
  return root
}

function manifest(extra = ''): string {
  return `{ "name": "fixture", "type": "module"${extra} }`
}

function workspaceFiles(source: Partial<Record<'contract' | 'starter', string>>, manifests: Partial<Record<'contract' | 'starter', string>> = {}): Record<string, string> {
  return {
    'packages/contract/package.json': manifests.contract ?? manifest(),
    'packages/contract/src/index.ts': source.contract ?? 'export const contract = true\n',
    'packages/theme-starter/package.json': manifests.starter ?? manifest(),
    'packages/theme-starter/src/index.ts': source.starter ?? 'export const starter = true\n',
  }
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ENG-028 regression helpers', () => {
  it('names artifacts without fixture text', () => expect(artifactName('ENG-028', 'chromium', 'home page is accessible')).toBe('ENG-028-chromium-home-page-is-accessible'))
  it('creates and removes an isolated SQLite location', async () => { let database = ''; await withIsolatedSqlitePath(async (path) => { database = path; await expect(access(path)).rejects.toThrow() }); await expect(access(database)).rejects.toThrow() })
})

describe('ENG-011 deterministic readiness report', () => {
  const asOf = '2026-10-02T12:00:00.000Z'

  it('passes the neutral fixture with a stable AI-unavailable status', () => {
    const result = checkSiteSnapshot(neutralFixture, { asOf })
    expect(result).toMatchObject({ version: 1, asOf, publishable: true, issues: [], stalePages: [], ai: { status: 'unavailable', code: 'AI_PROVIDER_UNAVAILABLE' } })
  })

  it('returns contract failures as publish blockers with exact field paths', () => {
    const result = checkSiteSnapshot({ settings: {}, pages: [], media: [], redirects: [], changeSets: [] }, { asOf })
    expect(result.publishable).toBe(false)
    expect(result.blockers[0]).toMatchObject({ code: 'SCHEMA_INVALID', severity: 'blocker', path: 'settings.contractVersion', remediation: 'Correct this field so the snapshot satisfies the public content contract.' })
  })

  it('surfaces missing non-decorative media alt text through the same schema report', () => {
    const snapshot = structuredClone(neutralFixture)
    snapshot.media.push({ id: 'abababab-abab-4bab-8bab-abababababab', filename: 'diagram.png', decorative: false, width: 120, height: 80, mimeType: 'image/png' } as never)
    const result = checkSiteSnapshot(snapshot, { asOf })
    expect(result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SCHEMA_INVALID', path: 'media.0.alt', severity: 'blocker' })]))
  })

  it('reports readiness blockers for headings, links, and generated structured data', () => {
    const snapshot = structuredClone(neutralFixture)
    snapshot.pages[0]!.blocks[0]!.body = '# A duplicate title\n\n[Missing route](/missing)'
    snapshot.pages[0]!.blocks.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'richText', body: '### Skipped heading level', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } })
    const result = checkSiteSnapshot(snapshot, { asOf, structuredData: { [snapshot.pages[0]!.id]: { '@context': 'https://schema.org' } } })
    expect(result.publishable).toBe(false)
    expect(result.blockers.map((item) => item.code)).toEqual(expect.arrayContaining(['HEADING_H1_COUNT', 'HEADING_ORDER', 'INTERNAL_LINK_BROKEN', 'STRUCTURED_DATA_INVALID']))
    expect(result.blockers.find((item) => item.code === 'STRUCTURED_DATA_INVALID')).toMatchObject({ severity: 'blocker', path: `structuredData.${snapshot.pages[0]!.id}`, remediation: 'Fix structured-data generation before publishing.' })
  })

  it('resolves section landing paths, trailing slashes and external CTAs like the renderer', () => {
    const snapshot = structuredClone(neutralFixture)
    const section = snapshot.settings.sections[0]!
    const home = snapshot.pages[0]!
    const landing = { ...structuredClone(home), id: '11111111-1111-4111-8111-111111111111', slug: 'section-home' }
    section.landingPageId = landing.id
    section.pageIds.push(landing.id)
    snapshot.pages.push(landing)
    home.blocks[0]!.cta = { label: 'Section', href: `/${section.slug}/?from=home` }
    landing.blocks[0]!.cta = { label: 'External reference', href: 'https://example.test/reference' }
    expect(checkSiteSnapshot(snapshot, { asOf }).blockers.filter(issue => issue.code === 'INTERNAL_LINK_BROKEN')).toEqual([])
  })

  it('checks optional hero action and supporting-panel links', () => {
    const snapshot = structuredClone(neutralFixture)
    snapshot.settings.contractVersion = '1.1.0'
    const hero = snapshot.pages[0]!.blocks[0]!
    if (hero.type !== 'hero') throw new Error('Fixture must begin with a hero.')
    hero.secondaryCta = { label: 'Missing option', href: '/missing-option' }
    hero.supportPanel = { heading: 'Supporting information', body: 'Neutral supporting information.', cta: { label: 'Missing details', href: '/missing-details' } }
    const paths = checkSiteSnapshot(snapshot, { asOf }).blockers.filter(issue => issue.code === 'INTERNAL_LINK_BROKEN').map(issue => issue.path)
    expect(paths).toEqual(expect.arrayContaining(['pages.0.blocks.0.secondaryCta.href', 'pages.0.blocks.0.supportPanel.cta.href']))
  })

  it('keeps style, freshness, FAQ, lengths, and orphan checks as visible warnings', () => {
    const snapshot = structuredClone(neutralFixture)
    const page = snapshot.pages[0]!
    page.title = 'Brief'
    page.summary = 'Short'
    page.seoDescription = 'Short'
    page.blocks[1]!.items[0]!.answer = 'Yes.'
    page.blocks[0]!.body = 'Color is good. This deliberately elaborate sentence contains a collection of unnecessarily complicated terminology that continues far beyond the configured sentence length so readers have difficulty following the intended meaning and action.'
    page.updatedAt = '2025-01-01T00:00:00.000Z'
    snapshot.pages.push({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sectionId: page.sectionId, title: 'An unlinked standard information page', summary: 'This published page has a sufficiently descriptive neutral summary.', seoDescription: 'This published page has a sufficiently descriptive neutral search description.', slug: 'unlinked', template: 'landing', status: 'published', updatedAt: '2025-01-01T00:00:00.000Z', blocks: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', type: 'hero', heading: 'Independent information', body: 'Clear content.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] })
    snapshot.settings.sections[0]!.pageIds.push('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    const result = checkSiteSnapshot(snapshot, { asOf, reviewFreshnessDays: 30, style: { bannedPhrases: ['good'], preferredTerms: [{ avoid: 'color', prefer: 'colour' }], canadianSpelling: 'warn', maximumSentenceWords: 8, minimumReadingEase: 100 } })
    expect(result.publishable).toBe(true)
    expect(result.warnings.map((item) => item.code)).toEqual(expect.arrayContaining(['TITLE_LENGTH', 'SUMMARY_LENGTH', 'SEO_DESCRIPTION_LENGTH', 'FAQ_SELF_CONTAINED', 'REVIEW_STALE', 'STYLE_BANNED_PHRASE', 'STYLE_PREFERRED_TERM', 'STYLE_CANADIAN_SPELLING', 'STYLE_SENTENCE_LENGTH', 'STYLE_READING_LEVEL']))
    expect(result.stalePages).toHaveLength(2)
  })

  it('identifies a root page without an inbound link as an orphan and permits an explicit allowlist', () => {
    const snapshot = structuredClone(neutralFixture)
    const page = snapshot.pages[0]!
    snapshot.pages.push({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sectionId: page.sectionId, title: 'A second neutral standard page', summary: 'This published page has a sufficiently descriptive neutral summary.', seoDescription: 'This published page has a sufficiently descriptive neutral search description.', slug: 'orphan', template: 'service', parentId: page.id, status: 'published', blocks: [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', type: 'richText', body: 'Clear content.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] })
    // A service needs a pillar parent, so make the synthetic page an independent landing instead.
    snapshot.pages[1]!.template = 'landing'
    delete snapshot.pages[1]!.parentId
    snapshot.pages[1]!.blocks.unshift({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', type: 'hero', heading: 'Independent content', body: 'Clear content.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } })
    snapshot.settings.sections[0]!.allowedTemplates.push('landing')
    snapshot.settings.sections[0]!.pageIds.push(snapshot.pages[1]!.id)
    const unallowed = checkSiteSnapshot(snapshot, { asOf })
    expect(unallowed.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ORPHAN_PAGE', pageId: snapshot.pages[1]!.id })]))
    expect(checkSiteSnapshot(snapshot, { asOf, allowlistedOrphanPageIds: [snapshot.pages[1]!.id] }).warnings.some((item) => item.code === 'ORPHAN_PAGE')).toBe(false)
  })
})

describe('public package boundaries', () => {
  it('allows starter source to import the public contract', async () => {
    const root = await fixture(workspaceFiles({ starter: "import { contract } from '@site-engine/contract'\nexport { contract }\n" }))
    await expect(inspectBoundaries(root)).resolves.toEqual([])
  })

  it('rejects a prohibited Astro import', async () => {
    const root = await fixture({
      ...workspaceFiles({}),
      'packages/theme-starter/src/Component.astro': "---\nimport Engine from '@site-engine/engine'\n---\n<Engine />\n",
    })
    await expect(inspectBoundaries(root)).resolves.toContain('packages/theme-starter/src/Component.astro imports prohibited @site-engine/engine')
  })

  it('rejects a prohibited dynamic subpath import', async () => {
    const root = await fixture(workspaceFiles({ contract: "await import('@site-engine/theme-starter/components/Layout.astro')\n" }))
    await expect(inspectBoundaries(root)).resolves.toContain('packages/contract/src/index.ts imports prohibited @site-engine/theme-starter/components/Layout.astro')
  })

  it('rejects a relative package escape', async () => {
    const root = await fixture(workspaceFiles({ starter: "import '../../../engine/src/index.js'\n" }))
    await expect(inspectBoundaries(root)).resolves.toContain('packages/theme-starter/src/index.ts imports outside its package: ../../../engine/src/index.js')
  })

  it('rejects prohibited development dependencies', async () => {
    const root = await fixture(workspaceFiles({}, { starter: manifest(', "devDependencies": { "@site-engine/engine": "workspace:*" }') }))
    await expect(inspectBoundaries(root)).resolves.toContain('@site-engine/theme-starter must not declare @site-engine/engine')
  })
})

describe('public provenance', () => {
  it('allows the exact RFC 7591 DCR field only in OAuth protocol files', async () => {
    const marker = 'client' + '_name'
    const root = await fixture({ 'apps/oauth/src/server.ts': `const field = '${marker}'\n`, 'apps/oauth/tests/protocol.test.ts': `const field = '${marker}'\n` })
    await expect(inspectPublicProvenance(root)).resolves.toEqual([])
  })

  it('still rejects that marker outside the narrowly allowed protocol files', async () => {
    const marker = 'client' + '_name'
    const root = await fixture({ 'apps/site/src/unsafe.ts': `const field = '${marker}'\n` })
    await expect(inspectPublicProvenance(root)).resolves.toHaveLength(1)
  })

  it('still rejects client assets and fixtures within OAuth protocol files', async () => {
    const root = await fixture({ 'apps/oauth/src/server.ts': `const field = '${'client' + '_asset'}'\n`, 'apps/oauth/tests/protocol.test.ts': `const field = '${'client' + '_fixture'}'\n` })
    await expect(inspectPublicProvenance(root)).resolves.toHaveLength(2)
  })
})
