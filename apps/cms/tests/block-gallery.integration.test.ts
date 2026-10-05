import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPayload } from 'payload'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'
import { createNamedChangeSet } from '../src/editorial'
import { withPayloadTransaction } from '../src/auth-transaction'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-block-gallery-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-block-gallery'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
const { default: config } = await import('../payload.config.js')
const recipeRoute = await import('../app/api/block-gallery/recipe/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>

async function sessionFor(userID: string) {
  const token = newOpaqueToken(); const now = new Date().toISOString()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: userID, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  return token
}
function request(token: string, body: unknown, origin = 'http://cms.test') {
  return recipeRoute.POST(new Request('http://cms.test/api/block-gallery/recipe', { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie: `${cookieName(SESSION_COOKIE)}=${token}` }, body: JSON.stringify(body) }))
}
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

test('ENG-018 captures a template-filtered recipe atomically for its owning editor', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'gallery-owner@example.test', name: 'Gallery Owner', roles: ['owner'] }, overrideAccess: true })
  const sales = await payload.create({ collection: 'users', data: { email: 'gallery-sales@example.test', name: 'Gallery Sales', roles: ['sales'] }, overrideAccess: true })
  const section = await payload.create({ collection: 'sections', data: { name: 'Gallery', summary: 'A synthetic section used to verify reviewed recipe insertion.', slug: 'gallery', allowedTemplates: ['landing', 'standard', 'article'] }, overrideAccess: true, context: { editorialInternal: true } })
  const standard = await payload.create({ collection: 'pages', data: { title: 'Recipe target', summary: 'A synthetic target page used for reviewed recipe insertion coverage.', slug: 'recipe-target', sectionId: section.id, template: 'standard', blocks: [] }, overrideAccess: true, context: { editorialInternal: true } })
  const article = await payload.create({ collection: 'pages', data: { title: 'Article target', summary: 'A synthetic article page used to prove rejected recipes roll back safely.', slug: 'article-target', sectionId: section.id, template: 'article', blocks: [] }, overrideAccess: true, context: { editorialInternal: true } })
  const landing = await payload.create({ collection: 'pages', data: { title: 'Landing target', summary: 'A synthetic landing page used to verify additive recipes.', slug: 'landing-target', sectionId: section.id, template: 'landing', blocks: [{ id: '11000000-0000-4000-8000-000000000001', type: 'hero', heading: 'Existing Hero', body: 'Existing landing content.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, overrideAccess: true, context: { editorialInternal: true } })
  const set = await withPayloadTransaction(payload, (req) => { req.user = owner as never; return createNamedChangeSet(payload, req, owner, 'Gallery recipe') })
  const ownerToken = await sessionFor(owner.id); const salesToken = await sessionFor(sales.id)
  const insertKey = randomUUID()
  const inserted = await request(ownerToken, { pageId: standard.id, changeSetId: String(set.id), expectedRevision: 0, requestKey: insertKey, blocks: [{ type: 'callout', appearance: { background: 'accent', width: 'wide', spacing: 'compact', motionIntent: 'subtle', logoTone: 'inverse' } }, { type: 'faq' }] })
  expect(inserted.status).toBe(201)
  const captured = await payload.findByID({ collection: 'change-sets', id: String(set.id), overrideAccess: true })
  expect(captured.changes).toEqual(expect.arrayContaining([expect.objectContaining({ collection: 'pages', id: standard.id, after: expect.objectContaining({ blocks: [expect.objectContaining({ type: 'callout', appearance: { background: 'accent', width: 'wide', spacing: 'compact', motionIntent: 'subtle', logoTone: 'inverse' } }), expect.objectContaining({ type: 'faq' })] }) })]))
  const replay = await request(ownerToken, { pageId: standard.id, changeSetId: String(set.id), expectedRevision: 0, requestKey: insertKey, blocks: [{ appearance: { logoTone: 'inverse', motionIntent: 'subtle', spacing: 'compact', width: 'wide', background: 'accent' }, type: 'callout' }, { type: 'faq' }] })
  expect(replay.status).toBe(201)
  expect((await replay.json()).page.blocks).toHaveLength(2)
  const conflictingReplay = await request(ownerToken, { pageId: standard.id, changeSetId: String(set.id), expectedRevision: 0, requestKey: insertKey, blocks: [{ type: 'callout' }] })
  expect(conflictingReplay.status).toBe(400)
  expect(await conflictingReplay.json()).toMatchObject({ error: expect.stringContaining('already used') })
  const landingInserted = await request(ownerToken, { pageId: landing.id, changeSetId: String(set.id), expectedRevision: captured.revision, requestKey: randomUUID(), blockTypes: ['callout', 'faq'] })
  expect(landingInserted.status).toBe(201)
  expect((await landingInserted.json()).page.blocks.map((block: { type: string }) => block.type)).toEqual(['hero', 'callout', 'faq'])
  const updatedRevision = (await payload.findByID({ collection: 'change-sets', id: String(set.id), overrideAccess: true })).revision
  const stale = await request(ownerToken, { pageId: landing.id, changeSetId: String(set.id), expectedRevision: captured.revision, requestKey: randomUUID(), blockTypes: ['callout'] })
  expect(stale.status).toBe(400)
  expect((await payload.findByID({ collection: 'pages', id: landing.id, draft: true, overrideAccess: true })).blocks).toHaveLength(3)
  const rejected = await request(ownerToken, { pageId: article.id, changeSetId: String(set.id), expectedRevision: updatedRevision, requestKey: randomUUID(), blockTypes: ['hero'] })
  expect(rejected.status).toBe(400)
  expect(await rejected.json()).toMatchObject({ error: expect.stringContaining('not allowed') })
  expect((await payload.findByID({ collection: 'pages', id: article.id, draft: true, overrideAccess: true })).blocks).toEqual([])
  expect((await payload.findByID({ collection: 'change-sets', id: String(set.id), overrideAccess: true })).revision).toBe(updatedRevision)
  expect((await request(salesToken, { pageId: standard.id, changeSetId: String(set.id), expectedRevision: updatedRevision, requestKey: randomUUID(), blockTypes: ['callout'] })).status).toBe(403)
  expect((await request(ownerToken, { pageId: standard.id, changeSetId: String(set.id), expectedRevision: captured.revision, requestKey: randomUUID(), blockTypes: ['callout'] }, 'http://evil.test')).status).toBe(403)
  const oversized = new Request('http://cms.test/api/block-gallery/recipe', { method: 'POST', headers: { origin: 'http://cms.test', 'content-type': 'application/json', cookie: `${cookieName(SESSION_COOKIE)}=${ownerToken}` }, body: JSON.stringify({ padding: 'x'.repeat(33_000) }) })
  expect((await recipeRoute.POST(oversized)).status).toBe(413)
})
