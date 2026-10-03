import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { withPayloadTransaction } from '../src/auth-transaction'
import { transitionChangeSet } from '../src/editorial'
import { canonicalHash, changeSetHash } from '../src/publishing'
import { prepareReviewPreview } from '../src/review-preview'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-theme-selection-'))
const registryFile = join(directory, 'theme-registry.json')
const db = join(directory, 'cms.sqlite')
const manifest = {
  name: 'synthetic-theme', version: '2.4.6', contract: '1.0.0', entry: './dist/renderer.js',
  standardBlocks: ['hero', 'faq'], settingKeys: ['tone'], extensionBlocks: [], motion: { presets: [], intentFallbacks: {} },
}
const registry = { themes: [{ manifest, installedAt: '2026-10-03T00:00:00.000Z' }] }

process.env.DATABASE_URI = `file:${db}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-theme-selection'
process.env.SITE_THEME_REGISTRY_JSON = registryFile
writeFileSync(registryFile, JSON.stringify(registry))

const { default: config } = await import('../payload.config.js')
const { parseThemeRegistry } = await import('../../site/scripts/theme-registry.mjs')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }); delete process.env.SITE_THEME_REGISTRY_JSON })

function baseline() {
  const value = structuredClone(neutralFixture)
  const sectionID = randomUUID(); const pageID = randomUUID()
  value.settings.sections[0]!.id = sectionID; value.settings.sections[0]!.pageIds = [pageID]
  value.pages[0]!.id = pageID; value.pages[0]!.sectionId = sectionID
  value.settings.homepageId = pageID
  value.settings.themeSettings = { 'retained-theme': { tone: 'preserved' } }
  return value
}

async function installPublishedBaseline(ownerID: string) {
  const manifest = baseline()
  const set = await payload.create({ collection: 'change-sets', data: { name: 'Synthetic baseline', actor: ownerID, state: 'published', revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
  const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: canonicalHash(manifest), changeSet: set.id, reviewRevision: 0, changeHash: 'baseline', manifest, themeVersion: '1.0.0', engineVersion: 'test-engine', contractVersion: '1.0.0', approvedBy: ownerID, baselineSequence: 0 }, overrideAccess: true, context: { editorialInternal: true } })
  const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: `baseline:${snapshot.id}`, sequence: 1, snapshot: snapshot.id, changeSet: set.id, reviewRevision: 0, changeHash: 'baseline', includedChangeKeys: [], status: 'completed', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence: 1, snapshot: snapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { status: 'healthy' }, artifact: { digest: 'a'.repeat(64), sourceContentHash: snapshot.contentHash, themeVersion: '1.0.0', engineVersion: 'test-engine', contractVersion: '1.0.0', checks: [{ name: 'artifact-integrity', status: 'passed' }, { name: 'public-health', status: 'passed' }] } }, overrideAccess: true, context: { editorialInternal: true } })
  return { manifest, snapshot }
}

describe('ENG-035 owner-controlled frozen theme selection', () => {
  it('captures an exact installed selection, preserves namespaces, and freezes it for preview without changing the published baseline', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `theme-owner-${randomUUID()}@example.test`, name: 'Theme owner', roles: ['owner'] }, overrideAccess: true })
    const editor = await payload.create({ collection: 'users', data: { email: `theme-editor-${randomUUID()}@example.test`, name: 'Theme editor', roles: ['editor'] }, overrideAccess: true })
    const { manifest: published, snapshot } = await installPublishedBaseline(owner.id)
    const installed = parseThemeRegistry(registry).get(manifest.name)!
    const selection = { id: manifest.name, version: manifest.version, contract: manifest.contract, manifestDigest: installed.manifestDigest }

    const settings = await payload.create({ collection: 'theme-settings', data: { selection, settings: { [manifest.name]: { tone: 'warm' } } }, draft: true, user: owner, overrideAccess: false })
    await expect(payload.update({ collection: 'theme-settings', id: settings.id, data: { settings: { [manifest.name]: { tone: 'cool' } } }, user: editor, overrideAccess: false })).rejects.toThrow()
    await expect(payload.update({ collection: 'theme-settings', id: settings.id, data: { selection: { ...selection, manifestDigest: 'bad' } }, user: owner, overrideAccess: false })).rejects.toThrow()
    writeFileSync(registryFile, JSON.stringify({ themes: [{ ...registry.themes[0], manifest: { ...manifest, version: '2.4.7' } }] }))
    await expect(payload.update({ collection: 'theme-settings', id: settings.id, data: { selection }, user: owner, overrideAccess: false })).rejects.toThrow(/installed exactly as reviewed/)
    writeFileSync(registryFile, JSON.stringify(registry))

    const setResult = await payload.find({ collection: 'change-sets', where: { actor: { equals: owner.id } }, depth: 0, overrideAccess: true })
    const set = setResult.docs.find((item) => Array.isArray(item.changes) && (item.changes as Array<{ collection?: string }>).some((change) => change.collection === 'theme-settings'))!
    const change = (set.changes as Array<{ collection: string; id: string }>).find((item) => item.collection === 'theme-settings')!
    const submitted = await withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: owner, id: set.id, action: 'submit' }))
    const job = await withPayloadTransaction(payload, req => prepareReviewPreview({ payload, req, actor: owner, id: set.id, expectedRevision: Number(submitted.revision), expectedChangeHash: changeSetHash(submitted.changes), includedChangeKeys: [`theme-settings:${change.id}`] }))
    const proposed = job.proposedManifest as typeof published

    expect(settings.selection).toEqual(selection)
    expect(proposed.settings.theme).toEqual(selection)
    expect(proposed.settings.themeSettings).toEqual({ 'retained-theme': { tone: 'preserved' }, [manifest.name]: { tone: 'warm' } })
    expect((await payload.findByID({ collection: 'publish-snapshots', id: snapshot.id, overrideAccess: true })).manifest).toEqual(published)
    expect((await payload.find({ collection: 'published-releases', overrideAccess: true })).totalDocs).toBe(1)
  })
})
