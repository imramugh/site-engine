import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { cookieName, hashOpaqueToken, newOpaqueToken, serverSessionStrategy, SESSION_COOKIE } from '../src/identity'
import { handleOAuthSessionBridge } from '../src/oauth-session-bridge'
import sharp from 'sharp'
import { mediaStorageDirectory, snapshotMediaReference } from '../src/media'
import { moveAssetToBin, restoreAssetFromBin } from '../src/media-lifecycle'
import { markStaleIfNeeded, transitionChangeSet } from '../src/editorial'
import { withPayloadTransaction } from '../src/auth-transaction'
import { neutralFixture } from '@site-engine/contract/fixtures'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-cms-'))
const db = join(directory, 'cms.sqlite')
process.env.DATABASE_URI = `file:${db}`
process.env.MEDIA_STORAGE_DIR = join(directory, 'media')
const contract14Baseline = join(directory, 'contract-1.4.json')
const contract13Baseline = join(directory, 'contract-1.3.json')
writeFileSync(contract14Baseline, JSON.stringify({ ...neutralFixture, settings: { ...neutralFixture.settings, contractVersion: '1.4.0' } }))
writeFileSync(contract13Baseline, JSON.stringify({ ...neutralFixture, settings: { ...neutralFixture.settings, contractVersion: '1.3.0' } }))
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-payload'
process.env.PREVIEW_THEME_VERSION = '1.0.0'
process.env.PREVIEW_ENGINE_VERSION = '1.0.0'
process.env.PREVIEW_CONTRACT_VERSION = '1.4.0'
const tokenFile = join(directory, 'bootstrap-token')
writeFileSync(tokenFile, 'test-only-bootstrap-token')
process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE = tokenFile

const { default: config } = await import('../payload.config.js')
const { GET: mediaWorkspaceGET, PATCH: mediaWorkspacePATCH } = await import('../app/api/media/workspace/route.js')
const { POST: mediaReplacementPOST } = await import('../app/api/media/replacement/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => {
  payload = await getPayload({ config })
}, 120_000)

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
    await expect(resolved.json()).resolves.toEqual({ user: { id: user.id, sessionId: first.id, scopes: ['mcp:content:read', 'mcp:content:write', 'mcp:redirects:read', 'mcp:redirects:write', 'mcp:leads:read', 'mcp:leads:reply', 'mcp:careers:read', 'mcp:careers:reply'] } })
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
    // Disabling staff must preserve another active Owner.
    await payload.create({ collection: 'users', data: { email: 'retained-owner@example.test', name: 'Retained Owner', roles: ['owner'] }, overrideAccess: true })
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

    for (const [role, scope] of [['sales', ['mcp:leads:read', 'mcp:leads:reply']], ['hiring', ['mcp:careers:read', 'mcp:careers:reply']]] as const) {
      const staff = await payload.create({ collection: 'users', data: { email: `bridge-${role}@example.test`, name: `Bridge ${role}`, roles: [role] }, overrideAccess: true })
      const token = newOpaqueToken()
      await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: staff.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
      const resolution = await resolve(token)
      expect(resolution.status).toBe(200)
      await expect(resolution.json()).resolves.toEqual({ user: { id: staff.id, sessionId: expect.any(String), scopes: scope } })
    }

    const mixed = await payload.create({ collection: 'users', data: { email: 'bridge-mixed@example.test', name: 'Bridge mixed', roles: ['editor', 'sales', 'hiring'] }, overrideAccess: true })
    const mixedToken = newOpaqueToken()
    const mixedSession = await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(mixedToken), user: mixed.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
    await expect((await resolve(mixedToken)).json()).resolves.toEqual({ user: { id: mixed.id, sessionId: mixedSession.id, scopes: ['mcp:content:read', 'mcp:content:write', 'mcp:redirects:read', 'mcp:redirects:write', 'mcp:leads:read', 'mcp:leads:reply', 'mcp:careers:read', 'mcp:careers:reply'] } })
    await payload.update({ collection: 'users', id: mixed.id, data: { roles: ['sales', 'hiring'] }, overrideAccess: true })
    expect((await resolve(mixedToken)).status).toBe(401)
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

  it('defers only an aged verified session refresh while SQLite has a writer, and still denies invalid identities', async () => {
    const aged = new Date(Date.now() - 61_000).toISOString()
    const future = new Date(Date.now() + 60_000).toISOString()
    const identity = async (email: string, options: { disabled?: boolean; revoked?: boolean; expired?: boolean } = {}) => {
      const user = await payload.create({ collection: 'users', data: { email, name: email, roles: ['editor'], disabled: options.disabled }, overrideAccess: true })
      const token = newOpaqueToken()
      const session = await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: new Date().toISOString(), lastSeenAt: aged, expiresAt: options.expired ? new Date(Date.now() - 1_000).toISOString() : future, ...(options.revoked ? { revokedAt: new Date().toISOString() } : {}) }, overrideAccess: true })
      return { user, session, headers: new Headers({ cookie: `${cookieName(SESSION_COOKIE)}=${token}` }) }
    }
    const valid = await identity('refresh-lock-valid@example.test')
    const expired = await identity('refresh-lock-expired@example.test', { expired: true })
    const revoked = await identity('refresh-lock-revoked@example.test', { revoked: true })
    const disabled = await identity('refresh-lock-disabled@example.test', { disabled: true })
    const external = createClient({ url: `file:${db}` })
    const lock = await external.transaction('write')
    try {
      await lock.execute({ sql: 'UPDATE auth_sessions SET updated_at = updated_at WHERE id = ?', args: [valid.session.id] })
      await expect(serverSessionStrategy.authenticate({ headers: valid.headers, payload })).resolves.toMatchObject({ user: { id: valid.user.id } })
      expect((await payload.findByID({ collection: 'auth-sessions', id: valid.session.id, overrideAccess: true })).lastSeenAt).toBe(aged)
      for (const invalid of [expired, revoked, disabled]) await expect(serverSessionStrategy.authenticate({ headers: invalid.headers, payload })).resolves.toEqual({ user: null })
    } finally { await lock.rollback(); external.close() }
    await expect(serverSessionStrategy.authenticate({ headers: valid.headers, payload })).resolves.toMatchObject({ user: { id: valid.user.id } })
    expect(Date.parse((await payload.findByID({ collection: 'auth-sessions', id: valid.session.id, overrideAccess: true })).lastSeenAt)).toBeGreaterThan(Date.parse(aged))
  }, 15_000)
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
    process.env.INITIAL_PUBLISH_BASELINE_FILE = contract14Baseline
    const owner = await payload.create({ collection: 'users', data: { email: 'media-owner@example.test', name: 'Media Owner', roles: ['owner'] }, overrideAccess: true })
    const file = { data: await raster(), mimetype: 'image/png', name: 'synthetic-media.png', size: 0 }
    file.size = file.data.length
    await expect(payload.create({ collection: 'assets', data: { decorative: false }, file, user: owner, overrideAccess: false })).rejects.toThrow('invalid: alt')
    const asset = await payload.create({ collection: 'assets', data: { alt: 'Synthetic teal test image', caption: 'Synthetic test caption', credit: 'Test fixture', tags: ['synthetic'], focalX: 25, focalY: 75 }, file, user: owner, overrideAccess: false })
    expect(asset.width).toBe(1200)
    expect(asset.height).toBe(800)
    expect(asset.sizes?.heroAvif?.filename).toBeTruthy()
    expect(asset.sizes?.cardWebp?.filename).toBeTruthy()
    expect(Number(asset.sizes?.heroAvif?.width) / Number(asset.sizes?.heroAvif?.height)).toBeCloseTo(asset.width! / asset.height!, 2)
    expect(Number(asset.sizes?.cardWebp?.width) / Number(asset.sizes?.cardWebp?.height)).toBeCloseTo(asset.width! / asset.height!, 2)
    expect(existsSync(`${mediaStorageDirectory()}/${asset.sizes?.heroAvif?.filename}`)).toBe(true)
    const captured = snapshotMediaReference(asset)
    const legacyCaptured = snapshotMediaReference(asset, false)
    expect(captured.filename).toBe(asset.filename)
    expect(captured.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(captured).toMatchObject({ focalX: 25, focalY: 75 })
    expect(legacyCaptured).not.toHaveProperty('focalX')
    expect(legacyCaptured).not.toHaveProperty('focalY')
    const updatedFocal = await payload.update({ collection: 'assets', id: asset.id, data: { focalX: 80, focalY: 20 }, user: owner, overrideAccess: false })
    expect(updatedFocal).toMatchObject({ focalX: 80, focalY: 20, filename: asset.filename })
    const recaptured = snapshotMediaReference(updatedFocal)
    expect(recaptured).toMatchObject({ focalX: 80, focalY: 20, filename: captured.filename, sha256: captured.sha256, variants: captured.variants })
    expect(captured).toMatchObject({ focalX: 25, focalY: 75 })
    const focalSets = await payload.find({ collection: 'change-sets', where: { actor: { equals: owner.id } }, limit: 10, depth: 0, overrideAccess: true })
    const capturedAsset = focalSets.docs.flatMap((set) => Array.isArray(set.changes) ? set.changes as Array<{ collection: string; id: string; after?: Record<string, unknown> }> : []).find((change) => change.collection === 'assets' && change.id === asset.id)
    expect(capturedAsset?.after).toMatchObject({ focalX: 80, focalY: 20 })
    process.env.INITIAL_PUBLISH_BASELINE_FILE = contract13Baseline
    try {
      const oldDefault = await payload.create({ collection: 'assets', data: { alt: 'Old contract centred image' }, file: { ...file, name: 'old-contract-centred.png' }, user: owner, overrideAccess: false })
      expect(oldDefault).toMatchObject({ focalX: 50, focalY: 50 })
      await expect(payload.create({ collection: 'assets', data: { alt: 'Old contract custom focal image', focalX: 25, focalY: 75 }, file: { ...file, name: 'old-contract-custom-focal.png' }, user: owner, overrideAccess: false })).rejects.toThrow('active contract 1.4')
      expect(existsSync(`${mediaStorageDirectory()}/old-contract-custom-focal.png`)).toBe(false)
      await expect(payload.update({ collection: 'assets', id: asset.id, data: { alt: 'Legacy-contract metadata edit' }, user: owner, overrideAccess: false })).resolves.toMatchObject({ alt: 'Legacy-contract metadata edit' })
      const legacySets = await payload.find({ collection: 'change-sets', where: { actor: { equals: owner.id } }, limit: 10, depth: 0, overrideAccess: true })
      const legacyCapturedAsset = legacySets.docs.flatMap((set) => Array.isArray(set.changes) ? set.changes as Array<{ collection: string; id: string; after?: Record<string, unknown> }> : []).find((change) => change.collection === 'assets' && change.id === asset.id)
      expect(legacyCapturedAsset?.after).not.toHaveProperty('focalX')
      await expect(payload.update({ collection: 'assets', id: asset.id, data: { focalX: 81, focalY: 20 }, user: owner, overrideAccess: false })).rejects.toThrow('active contract 1.4')
    } finally {
      process.env.INITIAL_PUBLISH_BASELINE_FILE = contract14Baseline
    }
    await expect(payload.update({ collection: 'assets', id: asset.id, data: { alt: 'Replacement' }, file, user: owner, overrideAccess: false })).rejects.toThrow('Upload a new asset')
    await expect(payload.update({ collection: 'assets', id: asset.id, data: { alt: 'Updated description' }, user: owner, overrideAccess: false })).resolves.toMatchObject({ alt: 'Updated description' })
    expect(captured.variants?.heroAvif).toMatchObject({ filename: asset.sizes?.heroAvif?.filename, width: asset.sizes?.heroAvif?.width, height: asset.sizes?.heroAvif?.height, mimeType: 'image/avif', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })

    const section = await payload.create({ collection: 'sections', data: { name: 'Media', summary: 'Synthetic media section used to verify asset usage and lifecycle validation.', slug: 'media-lifecycle', allowedTemplates: ['standard'] }, user: owner, overrideAccess: false })
    await expect(payload.create({ collection: 'pages', data: { title: 'Missing asset alt', summary: 'This page proves server validation refuses assets that have no accessible description.', slug: 'missing-asset-alt', sectionId: section.id, template: 'standard', blocks: [{ id: 'c1000000-0000-4000-8000-000000000001', type: 'media', mediaId: asset.id, hidden: false, appearance }] }, user: owner, overrideAccess: false })).resolves.toMatchObject({ id: expect.any(String) })
    const lifecycle = await moveAssetToBin(payload, { payload } as never, owner, asset.id, new Date('2026-10-03T00:00:00.000Z'))
    expect(lifecycle).toMatchObject({ status: 'blocked', usages: [{ pageTitle: 'Missing asset alt', locations: ['blocks[0].mediaId'] }] })
  })


  it('authorizes the bounded media workspace read and metadata routes without leaking asset usage', async () => {
    process.env.INITIAL_PUBLISH_BASELINE_FILE = contract14Baseline
    process.env.PAYLOAD_PUBLIC_SERVER_URL = 'https://cms.example.test'
    const owner = await payload.create({ collection: 'users', data: { email: 'workspace-owner@example.test', name: 'Workspace Owner', roles: ['owner'] }, overrideAccess: true })
    const editor = await payload.create({ collection: 'users', data: { email: 'workspace-editor@example.test', name: 'Workspace Editor', roles: ['editor'] }, overrideAccess: true })
    const denied = []; for (const role of ['sales', 'hiring'] as const) denied.push(await payload.create({ collection: 'users', data: { email: `workspace-${role}@example.test`, name: role, roles: [role] }, overrideAccess: true }))
    const disabled = await payload.create({ collection: 'users', data: { email: 'workspace-disabled@example.test', name: 'Disabled', roles: ['editor'], disabled: true }, overrideAccess: true })
    const raster = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#155e75' } }).png().toBuffer()
    const asset = await payload.create({ collection: 'assets', data: { alt: 'Private synthetic usage image' }, file: { data: raster, mimetype: 'image/png', name: 'workspace-private.png', size: raster.length }, user: owner, overrideAccess: false })
    const section = await payload.create({ collection: 'sections', data: { name: 'Workspace use', summary: 'Synthetic section for media route safety.', slug: 'workspace-use', allowedTemplates: ['standard'] }, user: owner, overrideAccess: false })
    const usagePage = await payload.create({ collection: 'pages', data: { title: 'Private usage page', summary: 'Synthetic page with an asset reference.', slug: 'workspace-private-use', sectionId: section.id, template: 'standard', blocks: [{ id: 'd1000000-0000-4000-8000-000000000001', type: 'media', mediaId: asset.id, hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, user: owner, overrideAccess: false })
    const token = async (user: { id: string }) => { const value = newOpaqueToken(); const now = new Date().toISOString(); await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(value), user: user.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true }); return value }
    const headers = async (user: { id: string }) => new Headers({ cookie: `${cookieName(SESSION_COOKIE)}=${await token(user)}` })
    const ownerHeaders = await headers(owner); const editorHeaders = await headers(editor); const status = async (response: Promise<Response>) => { const result = await response; await result.text(); return result.status }
    expect(await status(mediaWorkspaceGET(new Request('https://cms.example.test/api/media/workspace?q=workspace-private', { headers: ownerHeaders })))).toBe(200)
    const ownerBody = await (await mediaWorkspaceGET(new Request('https://cms.example.test/api/media/workspace?q=workspace-private', { headers: ownerHeaders }))).json() as { assets: Array<{ id: string; usages: unknown[]; focalX: number; focalY: number }> }
    expect(ownerBody.assets.find((item) => item.id === asset.id)?.usages).toHaveLength(1)
    expect(ownerBody.assets.find((item) => item.id === asset.id)).toMatchObject({ focalX: 50, focalY: 50 })
    expect(await status(mediaWorkspaceGET(new Request('https://cms.example.test/api/media/workspace', { headers: editorHeaders })))).toBe(200)
    for (const user of [...denied, disabled]) expect(await status(mediaWorkspaceGET(new Request('https://cms.example.test/api/media/workspace', { headers: await headers(user) })))).toBe(403)
    expect(await status(mediaWorkspaceGET(new Request('https://cms.example.test/api/media/workspace')))).toBe(403)
    const patch = (body: unknown, headers: Headers) => mediaWorkspacePATCH(new Request('https://cms.example.test/api/media/workspace', { method: 'PATCH', headers: new Headers({ ...Object.fromEntries(headers), origin: 'https://cms.example.test', 'content-type': 'application/json' }), body: JSON.stringify(body) }))
    expect(await status(mediaWorkspacePATCH(new Request('https://cms.example.test/api/media/workspace', { method: 'PATCH', headers: ownerHeaders, body: '{}' })))).toBe(403)
    expect(await status(patch({ id: asset.id, alt: 'Updated safe description', decorative: false, unexpected: true }, ownerHeaders))).toBe(400)
    expect(await status(patch({ id: asset.id, alt: 'Updated safe description', decorative: false, focalX: -1, focalY: 50 }, ownerHeaders))).toBe(400)
    expect(await status(patch({ id: asset.id, alt: 'Updated safe description', decorative: false, focalX: 50, focalY: '50' }, ownerHeaders))).toBe(400)
    expect(await status(patch({ id: asset.id, alt: 'x'.repeat(9_000), decorative: false }, ownerHeaders))).toBe(413)
    expect(await status(patch({ id: asset.id, alt: 'Updated safe description', decorative: false, tags: ['safe'], focalX: 27.6, focalY: 72.2 }, editorHeaders))).toBe(200)
    expect(await payload.findByID({ collection: 'assets', id: asset.id, overrideAccess: true })).toMatchObject({ alt: 'Updated safe description', focalX: 28, focalY: 72 })

    const replacement = await sharp({ create: { width: 48, height: 64, channels: 3, background: '#9333ea' } }).png().toBuffer()
    const replacementKey = '99999999-9999-4999-8999-999999999999'
    const replace = (key = replacementKey, bytes = replacement, requestHeaders = ownerHeaders) => { const form = new FormData(); form.set('assetId', asset.id); form.set('idempotencyKey', key); form.set('file', new File([bytes], 'workspace-replacement.png', { type: 'image/png' })); return mediaReplacementPOST(new Request('https://cms.example.test/api/media/replacement', { method: 'POST', headers: new Headers({ ...Object.fromEntries(requestHeaders), origin: 'https://cms.example.test' }), body: form })) }
    expect(await status(mediaReplacementPOST(new Request('https://cms.example.test/api/media/replacement', { method: 'POST', headers: ownerHeaders })))).toBe(403)
    expect(await status(replace('88888888-8888-4888-8888-888888888888', replacement, await headers(denied[0]!)))).toBe(403)
    const beforeReplacement = snapshotMediaReference(asset)
    const originalHash = createHash('sha256').update(readFileSync(`${mediaStorageDirectory()}/${beforeReplacement.filename}`)).digest('hex')
    expect(await status(replace(replacementKey, Buffer.from('not an image')))).toBe(400)
    expect((await payload.find({ collection: 'asset-file-versions', where: { parentAsset: { equals: asset.id } }, limit: 10, depth: 0, overrideAccess: true })).totalDocs).toBe(0)
    const concurrentReplacements = await Promise.all([replace(), replace()])
    expect(concurrentReplacements.map(({ status }) => status)).toEqual([200, 200])
    expect(await Promise.all(concurrentReplacements.map((response) => response.json()))).toEqual(expect.arrayContaining([
      expect.objectContaining({ asset: expect.objectContaining({ id: asset.id, width: 48, height: 64 }) }),
      expect.objectContaining({ asset: expect.objectContaining({ id: asset.id, width: 48, height: 64 }) }),
    ]))
    const replay = await replace()
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ asset: { id: asset.id }, replayed: true })
    expect(await status(replace(replacementKey, await sharp(replacement).negate().png().toBuffer()))).toBe(409)
    expect((await payload.find({ collection: 'asset-file-versions', where: { parentAsset: { equals: asset.id } }, limit: 10, depth: 0, overrideAccess: true })).totalDocs).toBe(1)
    const replaced = await payload.findByID({ collection: 'assets', id: asset.id, depth: 0, overrideAccess: true })
    expect(replaced.currentFileVersion).toBeTruthy()
    const afterReplacement = snapshotMediaReference(replaced)
    expect(afterReplacement).toMatchObject({ id: asset.id, width: 48, height: 64 })
    expect(afterReplacement.filename).toMatch(new RegExp(`^${asset.id}-[0-9a-f-]{36}\\.png$`))
    expect(replaced.currentFile).toMatchObject({ originalFilename: 'workspace-replacement.png', filename: afterReplacement.filename })
    expect(afterReplacement.filename).not.toBe(beforeReplacement.filename)
    const replacementSets = await payload.find({ collection: 'change-sets', where: { actor: { equals: owner.id } }, limit: 10, depth: 0, overrideAccess: true })
    const replacementSet = replacementSets.docs.find((set) => Array.isArray(set.changes) && (set.changes as Array<{ collection: string; id: string; after?: Record<string, unknown> }>).some((change) => change.collection === 'assets' && change.id === asset.id && change.after?.filename === afterReplacement.filename))
    const replacementChange = (replacementSet?.changes as Array<{ collection: string; id: string; after?: Record<string, unknown> }> | undefined)?.find((change) => change.collection === 'assets' && change.id === asset.id)
    expect(replacementChange?.after).toMatchObject({ id: asset.id, filename: afterReplacement.filename, sha256: afterReplacement.sha256, width: 48, height: 64, focalX: 28, focalY: 72 })
    expect(replacementSet).toBeTruthy()
    const revalidatedReplacement = await withPayloadTransaction(payload, (req) => {
      req.user = owner as never
      return markStaleIfNeeded(payload, replacementSet as unknown as Record<string, unknown>, req)
    })
    expect(revalidatedReplacement.state).toBe('open')
    const replacementSearch = await (await mediaWorkspaceGET(new Request('https://cms.example.test/api/media/workspace?q=workspace-replacement.png', { headers: ownerHeaders }))).json() as { assets: Array<{ id: string; filename: string }> }
    expect(replacementSearch.assets).toEqual([expect.objectContaining({ id: asset.id, filename: 'workspace-replacement.png' })])
    expect(existsSync(`${mediaStorageDirectory()}/${beforeReplacement.filename}`)).toBe(true)
    expect(createHash('sha256').update(readFileSync(`${mediaStorageDirectory()}/${beforeReplacement.filename}`)).digest('hex')).toBe(originalHash)
    expect(snapshotMediaReference(asset)).toEqual(beforeReplacement)
    expect(await payload.findByID({ collection: 'pages', id: usagePage.id, depth: 0, overrideAccess: true })).toMatchObject({ id: usagePage.id, blocks: [expect.objectContaining({ mediaId: asset.id })] })
    const secondKey = '55555555-5555-4555-8555-555555555555'
    expect(await status(replace(secondKey))).toBe(200)
    expect((await payload.find({ collection: 'asset-file-versions', where: { parentAsset: { equals: asset.id } }, limit: 10, depth: 0, overrideAccess: true })).totalDocs).toBe(2)
    expect(await status(replace(secondKey, await sharp(replacement).negate().png().toBuffer()))).toBe(409)
    await expect(payload.create({ collection: 'asset-file-versions', data: { parentAsset: asset.id, digest: '0'.repeat(64), versionKey: `${asset.id}:blocked`, idempotencyKey: '77777777-7777-4777-8777-777777777777', originalFilename: 'blocked-direct-version.png' }, file: { data: replacement, mimetype: 'image/png', name: 'blocked-direct-version.png', size: replacement.length }, user: owner, overrideAccess: false })).rejects.toThrow('media replacement service')
    expect(existsSync(`${mediaStorageDirectory()}/blocked-direct-version.png`)).toBe(false)
    await expect(payload.find({ collection: 'asset-file-versions', limit: 10, depth: 0, user: denied[0], overrideAccess: false })).rejects.toThrow('not allowed')

    const crashBytes = await sharp({ create: { width: 60, height: 30, channels: 3, background: '#16a34a' } }).png().toBuffer()
    const crashDigest = createHash('sha256').update(crashBytes).digest('hex')
    const crashKey = '66666666-6666-4666-8666-666666666666'
    const orphan = await payload.create({ collection: 'asset-file-versions', data: { parentAsset: asset.id, digest: crashDigest, versionKey: `${asset.id}:${crashDigest}:${crashKey}`, idempotencyKey: crashKey, originalFilename: 'crash-safe-replacement.png' }, file: { data: crashBytes, mimetype: 'image/png', name: `${asset.id}-${crashKey}.png`, size: crashBytes.length }, user: owner, overrideAccess: true, context: { mediaReplacementVersion: true } })
    expect(String(replaced.currentFileVersion)).not.toBe(orphan.id)
    const crashRetry = await replace(crashKey, crashBytes)
    expect(crashRetry.status).toBe(200)
    expect(await crashRetry.json()).toMatchObject({ asset: { id: asset.id, width: 60, height: 30 }, replayed: true })
    expect(await payload.findByID({ collection: 'assets', id: asset.id, depth: 0, overrideAccess: true })).toMatchObject({ id: asset.id, currentFileVersion: orphan.id })

    const discardOwner = await payload.create({ collection: 'users', data: { email: 'replacement-discard@example.test', name: 'Replacement Discard', roles: ['owner'] }, overrideAccess: true })
    const discardSource = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#dc2626' } }).png().toBuffer()
    const discardAsset = await payload.create({ collection: 'assets', data: { alt: 'Replacement discard source' }, file: { data: discardSource, mimetype: 'image/png', name: 'replacement-discard-source.png', size: discardSource.length }, overrideAccess: true })
    const discardBefore = snapshotMediaReference(discardAsset)
    const discardBaseline = join(directory, 'replacement-discard-baseline.json')
    writeFileSync(discardBaseline, JSON.stringify({ ...neutralFixture, settings: { ...neutralFixture.settings, contractVersion: '1.4.0' }, media: [...neutralFixture.media, discardBefore] }))
    process.env.INITIAL_PUBLISH_BASELINE_FILE = discardBaseline
    const discardHeaders = await headers(discardOwner)
    const discardKey = '44444444-4444-4444-8444-444444444444'
    const discardForm = new FormData(); discardForm.set('assetId', discardAsset.id); discardForm.set('idempotencyKey', discardKey); discardForm.set('file', new File([replacement], 'discarded-replacement.png', { type: 'image/png' }))
    expect(await status(mediaReplacementPOST(new Request('https://cms.example.test/api/media/replacement', { method: 'POST', headers: new Headers({ ...Object.fromEntries(discardHeaders), origin: 'https://cms.example.test' }), body: discardForm })))).toBe(200)
    const discardChanged = await payload.findByID({ collection: 'assets', id: discardAsset.id, depth: 0, overrideAccess: true })
    const discardedVersionFilename = snapshotMediaReference(discardChanged).filename
    expect(discardedVersionFilename).not.toBe(discardBefore.filename)
    const discardSets = await payload.find({ collection: 'change-sets', where: { actor: { equals: discardOwner.id } }, limit: 10, depth: 0, overrideAccess: true })
    expect(discardSets.docs).toHaveLength(1)
    await withPayloadTransaction(payload, (req) => { req.user = discardOwner as never; return transitionChangeSet({ payload, req, actor: discardOwner as never, id: discardSets.docs[0]!.id, action: 'discard' }) })
    const discardRestored = await payload.findByID({ collection: 'assets', id: discardAsset.id, depth: 0, overrideAccess: true })
    expect(discardRestored).toMatchObject({ id: discardAsset.id, currentFileVersion: null, currentFile: null })
    expect(snapshotMediaReference(discardRestored)).toEqual(discardBefore)
    expect(existsSync(`${mediaStorageDirectory()}/${discardedVersionFilename}`)).toBe(true)
    process.env.INITIAL_PUBLISH_BASELINE_FILE = contract14Baseline
  }, 60_000)

  it('allows a decorative image and bins an unused asset for exactly thirty days', async () => {
    process.env.INITIAL_PUBLISH_BASELINE_FILE = contract14Baseline
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
