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
import { claimPreviewRenderJob, completePreviewRenderJob, prepareReviewPreview } from '../src/review-preview'
import { runReviewQuality } from '../src/review-quality'
import { hashOpaqueToken, newOpaqueToken } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-theme-selection-'))
const registryFile = join(directory, 'theme-registry.json')
const db = join(directory, 'cms.sqlite')
const oldManifest = {
  name: 'synthetic-theme', version: '2.4.6', contract: '1.0.0', entry: './dist/renderer.js',
  standardBlocks: ['hero', 'faq'], settingKeys: ['tone'], extensionBlocks: [], motion: { presets: [], intentFallbacks: {} },
}
const manifest = { ...oldManifest, version: '2.4.7', contract: '1.1.0' }
const registry = { themes: [{ manifest: oldManifest, installedAt: '2026-10-03T00:00:00.000Z' }, { manifest, installedAt: '2026-10-04T00:00:00.000Z' }] }

process.env.DATABASE_URI = `file:${db}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-theme-selection'
process.env.SITE_THEME_REGISTRY_JSON = registryFile
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
writeFileSync(registryFile, JSON.stringify(registry))

const { default: config } = await import('../payload.config.js')
const { getInstalledTheme, parseThemeRegistry } = await import('@site-engine/engine/theme-registry')
const editorialRoute = await import('../app/api/editorial/[action]/route.js')
const themeRoute = await import('../app/api/themes/route.js')
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
  const oldTheme = getInstalledTheme(parseThemeRegistry(registry), oldManifest.name, oldManifest.version)!
  manifest.settings.theme = { id: oldManifest.name, version: oldManifest.version, contract: oldManifest.contract, manifestDigest: oldTheme.manifestDigest }
  const set = await payload.create({ collection: 'change-sets', data: { name: 'Synthetic baseline', actor: ownerID, state: 'published', revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
  const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: canonicalHash(manifest), changeSet: set.id, reviewRevision: 0, changeHash: 'baseline', manifest, themeVersion: oldManifest.version, engineVersion: 'test-engine', contractVersion: '1.0.0', approvedBy: ownerID, baselineSequence: 0 }, overrideAccess: true, context: { editorialInternal: true } })
  const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: `baseline:${snapshot.id}`, sequence: 1, snapshot: snapshot.id, changeSet: set.id, reviewRevision: 0, changeHash: 'baseline', includedChangeKeys: [], status: 'completed', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence: 1, snapshot: snapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { status: 'healthy' }, artifact: { digest: 'a'.repeat(64), sourceContentHash: snapshot.contentHash, themeVersion: oldManifest.version, engineVersion: 'test-engine', contractVersion: '1.0.0', checks: [{ name: 'artifact-integrity', status: 'passed' }, { name: 'public-health', status: 'passed' }] } }, overrideAccess: true, context: { editorialInternal: true } })
  return { manifest, snapshot }
}

describe('ENG-035 owner-controlled frozen theme selection', () => {
  it('captures an exact installed selection, preserves namespaces, and freezes it for preview without changing the published baseline', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: `theme-owner-${randomUUID()}@example.test`, name: 'Theme owner', roles: ['owner'] }, overrideAccess: true })
    const editor = await payload.create({ collection: 'users', data: { email: `theme-editor-${randomUUID()}@example.test`, name: 'Theme editor', roles: ['editor'] }, overrideAccess: true })
    const { manifest: published, snapshot } = await installPublishedBaseline(owner.id)
    const installed = getInstalledTheme(parseThemeRegistry(registry), manifest.name, manifest.version)!
    const selection = { id: manifest.name, version: manifest.version, contract: manifest.contract, manifestDigest: installed.manifestDigest }

    const settings = await payload.create({ collection: 'theme-settings', data: { selection, settings: { [manifest.name]: { tone: 'warm' } } }, draft: true, user: owner, overrideAccess: false })
    await expect(payload.update({ collection: 'theme-settings', id: settings.id, data: { settings: { [manifest.name]: { tone: 'cool' } } }, user: editor, overrideAccess: false })).rejects.toThrow()
    await expect(payload.update({ collection: 'theme-settings', id: settings.id, data: { selection: { ...selection, manifestDigest: 'bad' } }, user: owner, overrideAccess: false })).rejects.toThrow()
    writeFileSync(registryFile, JSON.stringify({ themes: registry.themes.map((entry) => entry.manifest.version === manifest.version ? { ...entry, manifest: { ...manifest, version: '2.4.8' } } : entry) }))
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
    expect(proposed.settings.contractVersion).toBe('1.1.0')
    expect(job.versionPins).toMatchObject({ themeVersion: manifest.version, liveThemeVersion: oldManifest.version, engineVersion: 'test-engine', contractVersion: '1.1.0', liveContractVersion: '1.0.0' })
    expect(proposed.settings.themeSettings).toEqual({ 'retained-theme': { tone: 'preserved' }, [manifest.name]: { tone: 'warm' } })
    expect((await payload.findByID({ collection: 'publish-snapshots', id: snapshot.id, overrideAccess: true })).manifest).toEqual(published)
    expect((await payload.find({ collection: 'published-releases', overrideAccess: true })).totalDocs).toBe(1)

    const lease = await withPayloadTransaction(payload, req => claimPreviewRenderJob(payload, req))
    await withPayloadTransaction(payload, req => completePreviewRenderJob(payload, req, String(job.id), String(lease?.leaseToken), { liveManifestHash: String(job.liveManifestHash), proposedManifestHash: String(job.proposedManifestHash), artifactDigest: 'b'.repeat(64) }))
    await withPayloadTransaction(payload, req => runReviewQuality({ payload, req, id: set.id }))
    const token = newOpaqueToken(); const now = new Date().toISOString()
    await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: owner.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
    const quality = await payload.findByID({ collection: 'change-sets', id: set.id, overrideAccess: true })
    const proof = (quality.quality as { proof: Record<string, unknown> }).proof
    const request = (value: unknown) => editorialRoute.POST(new Request('http://cms.test/api/editorial/approve', { method: 'POST', headers: { origin: 'http://cms.test', 'content-type': 'application/json', cookie: `site_engine_session=${token}` }, body: JSON.stringify({ id: set.id, proof: value }) }), { params: Promise.resolve({ action: 'approve' }) })
    const tampered = structuredClone(proof) as { versionPins: Record<string, unknown> }
    tampered.versionPins.liveContractVersion = '1.1.0'
    expect((await request(tampered)).status).toBe(400)
    const omitted = structuredClone(proof) as { versionPins: Record<string, unknown> }
    delete omitted.versionPins.liveContractVersion
    expect((await request(omitted)).status).toBe(400)
    const response = await request(proof)
    expect(response.status).toBe(200)
    const approved = await response.json() as { snapshotID: string }
    const approvedSnapshot = await payload.findByID({ collection: 'publish-snapshots', id: approved.snapshotID, overrideAccess: true })
    expect(approvedSnapshot).toMatchObject({ contractVersion: '1.1.0', themeVersion: manifest.version })
    expect((approvedSnapshot.manifest as typeof proposed).settings.contractVersion).toBe('1.1.0')
  })

  it('allows a new reviewed preview when the singleton matches the published theme, reuses its owned draft, and denies a foreign pending selection', async () => {
    const registryValue = parseThemeRegistry(registry)
    const publishedTheme = getInstalledTheme(registryValue, oldManifest.name, oldManifest.version)!
    const proposedTheme = getInstalledTheme(registryValue, manifest.name, manifest.version)!
    const publishedSelection = { id: oldManifest.name, version: oldManifest.version, contract: oldManifest.contract, manifestDigest: publishedTheme.manifestDigest }
    const settings = await payload.find({ collection: 'theme-settings', where: { key: { equals: 'active' } }, limit: 1, depth: 0, draft: true, overrideAccess: true })
    if (settings.docs[0]) await payload.update({ collection: 'theme-settings', id: settings.docs[0].id, data: { selection: publishedSelection, settings: {} }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    else await payload.create({ collection: 'theme-settings', data: { key: 'active', selection: publishedSelection, settings: {} }, draft: true, overrideAccess: true, context: { editorialInternal: true } })

    const owner = await payload.create({ collection: 'users', data: { email: `theme-route-owner-${randomUUID()}@example.test`, name: 'Theme route owner', roles: ['owner'] }, overrideAccess: true })
    const other = await payload.create({ collection: 'users', data: { email: `theme-route-other-${randomUUID()}@example.test`, name: 'Theme route other owner', roles: ['owner'] }, overrideAccess: true })
    const session = async (user: typeof owner) => {
      const token = newOpaqueToken(); const now = new Date().toISOString()
      await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
      return token
    }
    const ownerToken = await session(owner); const otherToken = await session(other)
    const request = (token: string, id: string, version: string) => themeRoute.POST(new Request('http://cms.test/api/themes', { method: 'POST', headers: { origin: 'http://cms.test', 'content-type': 'application/json', cookie: `site_engine_session=${token}` }, body: JSON.stringify({ id, version, changeSetName: 'Reviewed route theme' }) }))
    const chooser = (token: string) => themeRoute.GET(new Request('http://cms.test/api/themes', { headers: { cookie: `site_engine_session=${token}` } }))

    const publishedChooser = await chooser(ownerToken)
    expect(publishedChooser.status).toBe(200)
    expect(await publishedChooser.json()).toMatchObject({ publishedSelection: { id: oldManifest.name, version: oldManifest.version }, draftSelection: null, draftChangeSet: null })

    const created = await request(ownerToken, manifest.name, manifest.version)
    expect(created.status, await created.clone().text()).toBe(201)
    expect(await created.json()).toMatchObject({ selection: { id: manifest.name, version: manifest.version }, reused: false })
    const ownedChooser = await chooser(ownerToken)
    expect(await ownedChooser.json()).toMatchObject({ draftSelection: { id: manifest.name, version: manifest.version }, draftChangeSet: { state: 'open' } })
    const foreignChooser = await chooser(otherToken)
    expect(await foreignChooser.json()).toMatchObject({ draftSelection: { id: manifest.name, version: manifest.version }, draftChangeSet: null })
    const denied = await request(otherToken, oldManifest.name, oldManifest.version)
    expect(denied.status).toBe(400)
    expect(await denied.json()).toMatchObject({ error: expect.stringContaining('Another reviewed draft controls') })
    const reused = await request(ownerToken, manifest.name, manifest.version)
    expect(reused.status, await reused.clone().text()).toBe(200)
    expect(await reused.json()).toMatchObject({ selection: { id: proposedTheme.manifest.name, version: proposedTheme.manifest.version }, reused: true })
  })
})
