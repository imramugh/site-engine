import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { cookieName, hashOpaqueToken, newOpaqueToken, serverSessionStrategy, SESSION_COOKIE } from '../src/identity'
import { handleOAuthSessionBridge } from '../src/oauth-session-bridge'
import sharp from 'sharp'
import { existsSync } from 'node:fs'
import { mediaStorageDirectory, snapshotMediaReference } from '../src/media'
import { moveAssetToBin, restoreAssetFromBin } from '../src/media-lifecycle'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-cms-'))
const db = join(directory, 'cms.sqlite')
process.env.DATABASE_URI = `file:${db}`
process.env.MEDIA_STORAGE_DIR = join(directory, 'media')
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-payload'
const tokenFile = join(directory, 'bootstrap-token')
writeFileSync(tokenFile, 'test-only-bootstrap-token')
process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE = tokenFile

const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  await payload?.destroy()
  rmSync(directory, { recursive: true, force: true })
  delete process.env.MEDIA_STORAGE_DIR
})

describe('real SQLite Payload access controls and WAL (ENG-006, ENG-007, ENG-036)', () => {
  it('resolves and revalidates OAuth bridge sessions against current SQLite identity state', async () => {
    const secret = 'bridge-test-secret'
    const user = await payload.create({ collection: 'users', data: { email: 'bridge-owner@example.test', name: 'Bridge owner', roles: ['owner'] }, overrideAccess: true })
    const now = new Date().toISOString()
    const firstToken = newOpaqueToken()
    const secondToken = newOpaqueToken()
    const first = await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(firstToken), user: user.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
    const second = await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(secondToken), user: user.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
    const resolve = (token: string, suppliedSecret = secret) => handleOAuthSessionBridge(new Request('http://cms.test/api/internal/oauth/session', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-oauth-bridge-secret': suppliedSecret, cookie: `${cookieName(SESSION_COOKIE)}=${token}` }, body: JSON.stringify({ operation: 'resolve' }),
    }), payload, secret)

    const resolved = await resolve(firstToken)
    expect(resolved.status).toBe(200)
    await expect(resolved.json()).resolves.toEqual({ user: { id: user.id, sessionId: first.id, scopes: ['mcp:content:read', 'mcp:content:write', 'mcp:redirects:read', 'mcp:redirects:write'] } })
    const validated = await handleOAuthSessionBridge(new Request('http://cms.test/api/internal/oauth/session', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-oauth-bridge-secret': secret }, body: JSON.stringify({ operation: 'validate', sessionId: first.id, userId: user.id }),
    }), payload, secret)
    expect(validated.status).toBe(200)
    const wrongUser = await handleOAuthSessionBridge(new Request('http://cms.test/api/internal/oauth/session', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-oauth-bridge-secret': secret }, body: JSON.stringify({ operation: 'validate', sessionId: first.id, userId: 'other-user' }),
    }), payload, secret)
    expect(wrongUser.status).toBe(401)

    await payload.update({ collection: 'auth-sessions', id: second.id, data: { revokedAt: new Date().toISOString() }, overrideAccess: true })
    expect((await resolve(secondToken)).status).toBe(401)
    await payload.update({ collection: 'users', id: user.id, data: { disabled: true }, overrideAccess: true })
    expect((await resolve(firstToken)).status).toBe(401)

    const roleUser = await payload.create({ collection: 'users', data: { email: 'bridge-editor@example.test', name: 'Bridge editor', roles: ['editor'] }, overrideAccess: true })
    const roleToken = newOpaqueToken()
    await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(roleToken), user: roleUser.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
    expect((await resolve(roleToken)).status).toBe(200)
    await payload.update({ collection: 'users', id: roleUser.id, data: { roles: ['approver'] }, overrideAccess: true })
    expect((await resolve(roleToken)).status).toBe(401)

    const approver = await payload.create({ collection: 'users', data: { email: 'bridge-approver@example.test', name: 'Bridge approver', roles: ['approver'] }, overrideAccess: true })
    const approverToken = newOpaqueToken()
    await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(approverToken), user: approver.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
    const approverResolution = await resolve(approverToken)
    expect(approverResolution.status).toBe(200)
    await expect(approverResolution.json()).resolves.toMatchObject({ user: { id: approver.id, scopes: ['mcp:content:read', 'mcp:content:write', 'mcp:redirects:read'] } })
  })

  it('rejects unauthenticated, malformed, oversized, and non-POST OAuth bridge requests', async () => {
    const secret = 'bridge-test-secret'
    const request = (init: RequestInit) => handleOAuthSessionBridge(new Request('http://cms.test/api/internal/oauth/session', init), payload, secret)
    expect((await request({ method: 'GET' })).status).toBe(405)
    expect((await request({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
    expect((await request({ method: 'POST', headers: { 'content-type': 'application/json', 'x-oauth-bridge-secret': 'wrong' }, body: '{}' })).status).toBe(401)
    expect((await request({ method: 'POST', headers: { 'content-type': 'application/json', 'x-oauth-bridge-secret': secret }, body: JSON.stringify({ operation: 'resolve', unexpected: true }) })).status).toBe(400)
    expect((await request({ method: 'POST', headers: { 'content-type': 'application/json', 'x-oauth-bridge-secret': secret }, body: JSON.stringify({ operation: 'resolve', padding: 'x'.repeat(4_096) }) })).status).toBe(400)
  })

  it('persists WAL settings and denies unauthenticated reads and writes', async () => {
    const client = (payload.db as unknown as { client: { execute: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> } }).client
    const journalMode = await client.execute('PRAGMA journal_mode')
    const foreignKeys = await client.execute('PRAGMA foreign_keys')
    expect(journalMode.rows[0]?.journal_mode).toBe('wal')
    expect(foreignKeys.rows[0]?.foreign_keys).toBe(1)

    await expect(payload.create({
      collection: 'pages', data: { title: 'Blocked', summary: 'This should fail access control before field validation is evaluated by Payload.', slug: 'blocked', sectionId: '00000000-0000-4000-8000-000000000000', template: 'standard', blocks: [] }, draft: true, overrideAccess: false,
    })).rejects.toThrow()
    await expect(payload.find({ collection: 'pages', overrideAccess: false })).rejects.toThrow('not allowed')
  })

  it('creates a page through Payload with explicit user access and keeps draft unpublished', async () => {
    const owner = await payload.create({
      collection: 'users',
      data: { email: 'owner@example.test', name: 'Operator', roles: ['owner'] },
      overrideAccess: false,
      context: { bootstrapOperatorToken: 'test-only-bootstrap-token' },
    })
    const section = await payload.create({
      collection: 'sections',
      data: { name: 'Foundation', summary: 'This section contains the foundation content used by the integration test.', slug: 'foundation', allowedTemplates: ['standard'] },
      user: owner,
      overrideAccess: false,
    })
    const page = await payload.create({
      collection: 'pages', data: { title: 'Draft only', summary: 'This page is intentionally a draft so that public output cannot change during an edit.', slug: 'draft-only', sectionId: section.id, template: 'standard', _status: 'draft' },
      user: owner,
      overrideAccess: false,
    })
    expect(page._status).toBe('draft')
    await expect(payload.update({ collection: 'pages', id: page.id, data: { seoDescription: '' }, user: owner, overrideAccess: false })).resolves.toMatchObject({ id: page.id })
    await expect(payload.create({ collection: 'pages', data: { title: 'Never published', summary: 'This attempted publication must be denied because review and publishing are not implemented.', slug: 'never-published', sectionId: section.id, template: 'standard', _status: 'published' }, user: owner, overrideAccess: false })).rejects.toThrow('Publishing is unavailable')
    await expect(payload.update({ collection: 'pages', id: page.id, data: { _status: 'published' }, user: owner, overrideAccess: false })).rejects.toThrow('Publishing is unavailable')
    await expect(payload.create({ collection: 'change-sets', data: { name: 'Cannot forge workflow state', actor: owner.id, state: 'approved', revision: 0 }, user: owner, overrideAccess: false })).rejects.toThrow('not allowed')
    await expect(payload.find({ collection: 'pages', overrideAccess: false })).rejects.toThrow('not allowed')
    const disabledOwner = { ...owner, disabled: true }
    await expect(payload.find({ collection: 'pages', user: disabledOwner, overrideAccess: false })).rejects.toThrow('not allowed')
    await expect(payload.delete({ collection: 'pages', id: page.id, user: disabledOwner, overrideAccess: false })).rejects.toThrow()
  })

  it('checks the server session against SQLite on every request and revokes it when disabled', async () => {
    const owner = await payload.create({
      collection: 'users',
      data: { email: 'session-owner@example.test', name: 'Session owner', roles: ['owner'], provider: 'google', providerSubject: 'oidc-session-owner' },
      overrideAccess: false,
      context: { bootstrapOperatorToken: 'test-only-bootstrap-token' },
    })
    const token = newOpaqueToken()
    const now = new Date()
    await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: owner.id, authenticatedAt: now.toISOString(), lastSeenAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() }, overrideAccess: true })
    const headers = new Headers({ cookie: `${cookieName(SESSION_COOKIE)}=${token}` })
    await expect(serverSessionStrategy.authenticate({ headers, payload })).resolves.toMatchObject({ user: { id: owner.id } })
    await payload.update({ collection: 'users', id: owner.id, data: { disabled: true }, user: owner, req: { headers }, overrideAccess: false })
    await expect(serverSessionStrategy.authenticate({ headers, payload })).resolves.toEqual({ user: null })
    const audit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'identity.disabled' } }, overrideAccess: true })
    expect(audit.totalDocs).toBeGreaterThan(0)
  })
  it('keeps emergency credentials private and rejects owner API edits to those fields', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'private-owner@example.test', name: 'Private owner', roles: ['owner'], emergencyTotpSecret: 'synthetic-encrypted-secret', emergencyRecoveryHashes: ['synthetic-hash'], emergencyLastCounter: 123 }, overrideAccess: true })
    const token = newOpaqueToken(); const now = new Date().toISOString()
    await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: owner.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
    const headers = new Headers({ cookie: `${cookieName(SESSION_COOKIE)}=${token}` })
    const visible = await payload.findByID({ collection: 'users', id: owner.id, user: owner, overrideAccess: false })
    expect(visible).not.toHaveProperty('emergencyTotpSecret')
    expect(visible).not.toHaveProperty('emergencyRecoveryHashes')
    expect(visible).not.toHaveProperty('emergencyLastCounter')
    await payload.update({ collection: 'users', id: owner.id, data: { emergencyTotpSecret: 'attacker-replacement', emergencyLastCounter: 0 }, user: owner, req: { headers }, overrideAccess: false })
    const stored = await payload.findByID({ collection: 'users', id: owner.id, overrideAccess: true })
    expect(stored.emergencyTotpSecret).toBe('synthetic-encrypted-secret')
    expect(stored.emergencyLastCounter).toBe(123)
  })

  it('lets staff read only their own profile and no credential fields', async () => {
    const editor = await payload.create({ collection: 'users', data: { email: 'self-editor@example.test', name: 'Editor', roles: ['editor'] }, overrideAccess: true })
    const profile = await payload.findByID({ collection: 'users', id: editor.id, user: editor, overrideAccess: false })
    expect(profile.id).toBe(editor.id)
    const visibleUsers = await payload.find({ collection: 'users', user: editor, overrideAccess: false })
    expect(visibleUsers.docs.map((user) => user.id)).toEqual([editor.id])
  })

})

describe('ENG-003 content-tree and template invariants through the Payload API', () => {
  const pageData = (slug: string, sectionId: string, template: 'landing' | 'standard' | 'listing' | 'pillar' | 'service' | 'article' | 'job', parentId?: string) => ({
    title: slug.replace(/-/g, ' '),
    summary: `This synthetic page named ${slug} has the summary required by the content contract.`,
    slug,
    sectionId,
    template,
    ...(parentId ? { parentId } : {}),
  })

  it('ENG-002 returns a field-level API error for an undeclared appearance value', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'appearance-owner@example.test', name: 'Appearance Owner', roles: ['owner'] }, overrideAccess: true })
    const section = await payload.create({ collection: 'sections', data: { name: 'Appearance', summary: 'Synthetic section for contract appearance validation.', slug: 'appearance-contract', allowedTemplates: ['standard'] }, user: owner, overrideAccess: false })
    await expect(payload.create({ collection: 'pages', data: { ...pageData('invalid-appearance', section.id, 'standard'), blocks: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'hero', heading: 'Valid heading', body: 'Valid body.', hidden: false, appearance: { background: 'raw-colour', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, user: owner, overrideAccess: false })).rejects.toMatchObject({ data: { errors: expect.arrayContaining([expect.objectContaining({ path: 'blocks.0.appearance.background' })]) } })
  })

  it('enforces section policy, template parents, moves, subtree depth, and policy changes', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'tree-owner@example.test', name: 'Tree Owner', roles: ['owner'] }, overrideAccess: true })
    const services = await payload.create({
      collection: 'sections',
      data: { name: 'Services', summary: 'This section holds synthetic service pages for a database-backed tree test.', slug: 'services-tree', allowedTemplates: ['landing', 'standard', 'pillar', 'service'] },
      user: owner, overrideAccess: false,
    })
    await expect(payload.create({
      collection: 'pages', data: pageData('invalid-article', services.id, 'article'), user: owner, overrideAccess: false,
    })).rejects.toMatchObject({ data: { errors: expect.arrayContaining([expect.objectContaining({ path: 'template', message: expect.stringContaining('not allowed') })]) } })
    await expect(payload.create({
      collection: 'pages', data: pageData('invalid-service', services.id, 'service'), user: owner, overrideAccess: false,
    })).rejects.toMatchObject({ data: { errors: expect.arrayContaining([expect.objectContaining({ path: 'parentId', message: expect.stringContaining('pillar parent') })]) } })

    const pillar = await payload.create({ collection: 'pages', data: pageData('platform-pillar', services.id, 'pillar'), user: owner, overrideAccess: false })
    const service = await payload.create({ collection: 'pages', data: pageData('platform-service', services.id, 'service', pillar.id), user: owner, overrideAccess: false })
    await expect(payload.update({ collection: 'pages', id: pillar.id, data: { template: 'standard' }, draft: true, user: owner, overrideAccess: false })).rejects.toMatchObject({ data: { errors: expect.arrayContaining([expect.objectContaining({ path: 'template', message: expect.stringContaining('platform-service') })]) } })
    // Phase-one editorial capture has no reversible deletion representation.
    // Even an owner cannot bypass that boundary through the Payload API.
    await expect(payload.delete({ collection: 'pages', id: pillar.id, user: owner, overrideAccess: false })).rejects.toThrow('not allowed')
    await expect(payload.update({ collection: 'sections', id: services.id, data: { allowedTemplates: ['landing', 'pillar'] }, draft: true, user: owner, overrideAccess: false })).rejects.toMatchObject({ data: { errors: expect.arrayContaining([expect.objectContaining({ path: 'allowedTemplates' })]) } })
    await expect(payload.delete({ collection: 'sections', id: services.id, user: owner, overrideAccess: false })).rejects.toThrow('not allowed')

    const general = await payload.create({
      collection: 'sections',
      data: { name: 'General', summary: 'This section holds generic pages used to prove tree movement and depth validation.', slug: 'general-tree', allowedTemplates: ['standard'] },
      user: owner, overrideAccess: false,
    })
    const root = await payload.create({ collection: 'pages', data: pageData('tree-root', general.id, 'standard'), user: owner, overrideAccess: false })
    const second = await payload.create({ collection: 'pages', data: pageData('tree-second', general.id, 'standard', root.id), user: owner, overrideAccess: false })
    const third = await payload.create({ collection: 'pages', data: pageData('tree-third', general.id, 'standard', second.id), user: owner, overrideAccess: false })
    await expect(payload.create({ collection: 'pages', data: pageData('tree-fourth', general.id, 'standard', third.id), user: owner, overrideAccess: false })).rejects.toMatchObject({ data: { errors: expect.arrayContaining([expect.objectContaining({ path: 'parentId', message: expect.stringContaining('depth') })]) } })
    await expect(payload.update({ collection: 'pages', id: root.id, data: { parentId: third.id }, user: owner, overrideAccess: false })).rejects.toMatchObject({ data: { errors: expect.arrayContaining([expect.objectContaining({ path: 'parentId', message: expect.stringContaining('descendant') })]) } })
    const other = await payload.create({ collection: 'sections', data: { name: 'Other', summary: 'This separate section verifies that an ordinary page update cannot split a subtree.', slug: 'other-tree', allowedTemplates: ['standard'] }, user: owner, overrideAccess: false })
    await expect(payload.update({ collection: 'pages', id: root.id, data: { sectionId: other.id }, user: owner, overrideAccess: false })).rejects.toMatchObject({ data: { errors: expect.arrayContaining([expect.objectContaining({ path: 'sectionId', message: expect.stringContaining('child pages') })]) } })
  })

  it('permits the same URL segment in different sections while rejecting sibling duplication', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'slug-owner@example.test', name: 'Slug Owner', roles: ['owner'] }, overrideAccess: true })
    const one = await payload.create({ collection: 'sections', data: { name: 'One', summary: 'This section is the first location for a scoped URL segment integration test.', slug: 'slug-one', allowedTemplates: ['standard'] }, user: owner, overrideAccess: false })
    const two = await payload.create({ collection: 'sections', data: { name: 'Two', summary: 'This section is the second location for a scoped URL segment integration test.', slug: 'slug-two', allowedTemplates: ['standard'] }, user: owner, overrideAccess: false })
    await payload.create({ collection: 'pages', data: pageData('shared-segment', one.id, 'standard'), user: owner, overrideAccess: false })
    await expect(payload.create({ collection: 'pages', data: pageData('shared-segment', two.id, 'standard'), user: owner, overrideAccess: false })).resolves.toMatchObject({ slug: 'shared-segment' })
    await expect(payload.create({ collection: 'pages', data: pageData('shared-segment', one.id, 'standard'), user: owner, overrideAccess: false })).rejects.toMatchObject({ data: { errors: expect.arrayContaining([expect.objectContaining({ path: 'slug' })]) } })
  })

  it('creates a copied draft through the CMS API while preserving hierarchy and rejecting a duplicate sibling slug', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'duplicate-owner@example.test', name: 'Duplicate Owner', roles: ['owner'] }, overrideAccess: true })
    const section = await payload.create({ collection: 'sections', data: { name: 'Copies', summary: 'Synthetic section used to exercise copied page creation through the CMS API.', slug: 'copies-tree', allowedTemplates: ['standard'] }, user: owner, overrideAccess: false })
    const original = await payload.create({ collection: 'pages', data: pageData('original-copy', section.id, 'standard'), user: owner, overrideAccess: false })
    const duplicate = await payload.create({ collection: 'pages', data: { ...pageData('original-copy-copy', section.id, 'standard'), parentId: original.id }, user: owner, overrideAccess: false })
    expect(duplicate).toMatchObject({ template: original.template, status: 'draft' })
    expect(typeof duplicate.parentId === 'string' ? duplicate.parentId : duplicate.parentId?.id).toBe(original.id)
    await expect(payload.create({ collection: 'pages', data: { ...pageData('original-copy-copy', section.id, 'standard'), parentId: original.id }, user: owner, overrideAccess: false })).rejects.toMatchObject({ data: { errors: expect.arrayContaining([expect.objectContaining({ path: 'slug' })]) } })
  })

  it('serializes concurrent root-page writes so sibling slugs cannot race', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'race-owner@example.test', name: 'Race Owner', roles: ['owner'] }, overrideAccess: true })
    const section = await payload.create({ collection: 'sections', data: { name: 'Race', summary: 'This section verifies the transaction-backed sibling slug invariant under concurrent writes.', slug: 'race-tree', allowedTemplates: ['standard'] }, user: owner, overrideAccess: false })
    const results = await Promise.allSettled([
      payload.create({ collection: 'pages', data: pageData('racing-root', section.id, 'standard'), user: owner, overrideAccess: false }),
      payload.create({ collection: 'pages', data: pageData('racing-root', section.id, 'standard'), user: owner, overrideAccess: false }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const stored = await payload.find({ collection: 'pages', where: { sectionId: { equals: section.id }, slug: { equals: 'racing-root' } }, depth: 0, overrideAccess: true })
    expect(stored.totalDocs).toBe(1)
  })
})

describe('ENG-014 media library, variants, and lifecycle', () => {
  const raster = async () => sharp({ create: { width: 1200, height: 800, channels: 3, background: '#155e75' } }).png().toBuffer()
  const appearance = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' }

  it('rejects missing alt text, transforms a real upload, and blocks binning an in-use asset with locations', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'media-owner@example.test', name: 'Media Owner', roles: ['owner'] }, overrideAccess: true })
    const file = { data: await raster(), mimetype: 'image/png', name: 'synthetic-media.png', size: 0 }
    file.size = file.data.length
    await expect(payload.create({ collection: 'assets', data: { decorative: false }, file, user: owner, overrideAccess: false })).rejects.toThrow('invalid: alt')
    const asset = await payload.create({ collection: 'assets', data: { alt: 'Synthetic teal test image', caption: 'Synthetic test caption', credit: 'Test fixture', tags: ['synthetic'], focalX: 25, focalY: 75 }, file, user: owner, overrideAccess: false })
    expect(asset.width).toBe(1200)
    expect(asset.height).toBe(800)
    expect(asset.sizes?.heroAvif?.filename).toBeTruthy()
    expect(asset.sizes?.cardWebp?.filename).toBeTruthy()
    expect(existsSync(`${mediaStorageDirectory()}/${asset.sizes?.heroAvif?.filename}`)).toBe(true)
    const captured = snapshotMediaReference(asset)
    expect(captured.filename).toBe(asset.filename)
    expect(captured.sha256).toMatch(/^[a-f0-9]{64}$/)
    await expect(payload.update({ collection: 'assets', id: asset.id, data: { focalX: 80 }, user: owner, overrideAccess: false })).rejects.toThrow('Upload a new asset')
    await expect(payload.update({ collection: 'assets', id: asset.id, data: { alt: 'Replacement' }, file, user: owner, overrideAccess: false })).rejects.toThrow('Upload a new asset')
    expect(snapshotMediaReference(asset).sha256).toBe(captured.sha256)
    await expect(payload.update({ collection: 'assets', id: asset.id, data: { alt: 'Updated description', focalX: asset.focalX, focalY: asset.focalY }, user: owner, overrideAccess: false })).resolves.toMatchObject({ alt: 'Updated description' })
    expect(captured.variants?.heroAvif).toMatchObject({ filename: asset.sizes?.heroAvif?.filename, width: asset.sizes?.heroAvif?.width, height: asset.sizes?.heroAvif?.height, mimeType: 'image/avif', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })

    const section = await payload.create({ collection: 'sections', data: { name: 'Media', summary: 'Synthetic media section used to verify asset usage and lifecycle validation.', slug: 'media-lifecycle', allowedTemplates: ['standard'] }, user: owner, overrideAccess: false })
    await expect(payload.create({ collection: 'pages', data: { title: 'Missing asset alt', summary: 'This page proves server validation refuses assets that have no accessible description.', slug: 'missing-asset-alt', sectionId: section.id, template: 'standard', blocks: [{ id: 'c1000000-0000-4000-8000-000000000001', type: 'media', mediaId: asset.id, hidden: false, appearance }] }, user: owner, overrideAccess: false })).resolves.toMatchObject({ id: expect.any(String) })
    const lifecycle = await moveAssetToBin(payload, { payload } as never, owner, asset.id, new Date('2026-10-03T00:00:00.000Z'))
    expect(lifecycle).toMatchObject({ status: 'blocked', usages: [{ pageTitle: 'Missing asset alt', locations: ['blocks[0].mediaId'] }] })
  })

  it('allows a decorative image and bins an unused asset for exactly thirty days', async () => {
    const owner = await payload.create({ collection: 'users', data: { email: 'media-bin-owner@example.test', name: 'Media Bin Owner', roles: ['owner'] }, overrideAccess: true })
    const data = await raster()
    const asset = await payload.create({ collection: 'assets', data: { decorative: true }, file: { data, mimetype: 'image/png', name: 'decorative.png', size: data.length }, user: owner, overrideAccess: false })
    const result = await moveAssetToBin(payload, { payload } as never, owner, asset.id, new Date('2026-10-03T00:00:00.000Z'))
    expect(result).toEqual({ status: 'binned', deleteAfter: '2026-11-02T00:00:00.000Z' })
    const stored = await payload.findByID({ collection: 'assets', id: asset.id, overrideAccess: true })
    expect(stored.deletedAt).toBe('2026-10-03T00:00:00.000Z')
    await expect(payload.delete({ collection: 'assets', id: asset.id, user: owner, overrideAccess: false })).rejects.toThrow()
    await expect(payload.update({ collection: 'assets', id: asset.id, data: { deletedAt: null }, user: owner, overrideAccess: false })).rejects.toThrow()
    await expect(restoreAssetFromBin(payload, { payload } as never, owner, asset.id)).resolves.toEqual({ status: 'restored' })
    const restored = await payload.findByID({ collection: 'assets', id: asset.id, overrideAccess: true })
    expect(restored.deletedAt).toBeNull()
  })
})
