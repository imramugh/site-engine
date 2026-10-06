import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createClient } from '@libsql/client'
import sharp from 'sharp'
import { getPayload } from 'payload'
import { withPayloadTransaction } from '../src/auth-transaction'
import { snapshot as capturedSnapshot, transitionChangeSet } from '../src/editorial'
import { AppearanceOptions, CONTRACT_VERSION, SectionPresets, TemplateAllowedBlocks, TemplateSchema } from '@site-engine/contract'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { canonicalHash, changeSetHash } from '../src/publishing'
import { pageEditorHash, pageEditorProjection } from '../src/page-editor'
import { authorizeMailDraft } from '../src/mail-authorizations'
import { prepareReply, setReplyDeliveryForTest } from '../src/mail-replies'
import { hashOpaqueToken, newOpaqueToken } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-mcp-sdk-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.MEDIA_STORAGE_DIR = join(directory, 'media')
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-payload'
const { default: config } = await import('../payload.config.js')
const { handleMcp } = await import('../src/mcp.js')

type Token = { active?: boolean; clientId: string; userId: string; sessionId: string; scopes: string[]; resource?: string; expiresAt?: number }
const tokens = new Map<string, Token>()
let payload: Awaited<ReturnType<typeof getPayload>>
let mcpOrigin = ''
let oauthOrigin = ''
let introspections = 0
let mcpServer: ReturnType<typeof createServer>
let oauthServer: ReturnType<typeof createServer>

function requestFrom(incoming: IncomingMessage, origin: string, body: Buffer): Request {
  return new Request(`${origin}${incoming.url}`, { method: incoming.method, headers: incoming.headers as HeadersInit, body: body.length ? new Uint8Array(body) : undefined })
}

async function respond(outgoing: ServerResponse, response: Response) {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers))
  outgoing.end(Buffer.from(await response.arrayBuffer()))
}

async function startServer(handler: (incoming: IncomingMessage, outgoing: ServerResponse) => Promise<void>): Promise<{ server: ReturnType<typeof createServer>; origin: string }> {
  const server = createServer((incoming, outgoing) => { void handler(incoming, outgoing) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

function resultJson(result: unknown) {
  assert.ok(result && typeof result === 'object' && 'content' in result)
  const content = (result as { content: Array<{ type: string; text?: string }> }).content
  const block = content.find((item) => item.type === 'text')
  assert.ok(block?.text)
  return JSON.parse(block.text) as unknown
}

function structuredJson(result: unknown) {
  assert.ok(result && typeof result === 'object' && 'structuredContent' in result)
  return (result as { structuredContent: unknown }).structuredContent
}

function resourceJson(result: unknown) {
  assert.ok(result && typeof result === 'object' && 'contents' in result)
  const contents = (result as { contents: Array<{ text?: string }> }).contents
  assert.ok(contents[0]?.text)
  return JSON.parse(contents[0].text) as unknown
}

async function sessionFor(userId: string) {
  const now = new Date().toISOString()
  return payload.create({ collection: 'auth-sessions', data: { tokenHash: `mcp-${crypto.randomUUID()}`, user: userId, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 300_000).toISOString() }, overrideAccess: true })
}

async function clientFor(token: string) {
  const client = new Client({ name: `mcp-sdk-${token}`, version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpOrigin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } })
  await client.connect(transport)
  return { client, transport }
}

async function publishFrozenSnapshot(ownerID: string, manifest: typeof neutralFixture): Promise<void> {
  const sequence = (await payload.find({ collection: 'published-releases', limit: 0, overrideAccess: true })).totalDocs + 1
  const set = await payload.create({ collection: 'change-sets', data: { name: `Frozen MCP baseline ${randomUUID()}`, actor: ownerID, state: 'published', revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
  const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: canonicalHash(manifest), changeSet: set.id, reviewRevision: 0, changeHash: 'frozen-mcp-baseline', manifest, themeVersion: '1.0.0', engineVersion: 'test', contractVersion: '1.0.0', approvedBy: ownerID, baselineSequence: 0 }, overrideAccess: true, context: { editorialInternal: true } })
  const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: `mcp-baseline:${randomUUID()}`, sequence, snapshot: snapshot.id, changeSet: set.id, reviewRevision: 0, changeHash: 'frozen-mcp-baseline', includedChangeKeys: [], status: 'completed', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence, snapshot: snapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { status: 'healthy' }, artifact: { digest: 'a'.repeat(64), sourceContentHash: snapshot.contentHash, themeVersion: '1.0.0', engineVersion: 'test', contractVersion: '1.0.0', checks: [] } }, overrideAccess: true, context: { editorialInternal: true } })
}

beforeAll(async () => {
  payload = await getPayload({ config })
  const oauth = await startServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    if (incoming.method !== 'POST' || incoming.url !== '/internal/introspect' || incoming.headers['x-oauth-introspection-secret'] !== 'mcp-sdk-secret') { outgoing.writeHead(404); outgoing.end(); return }
    introspections += 1
    const input = JSON.parse(Buffer.concat(chunks).toString()) as { token?: string; resource?: string }
    const token = typeof input.token === 'string' ? tokens.get(input.token) : undefined
    let sessionActive = false
    if (token && token.active !== false) try {
      const session = await payload.findByID({ collection: 'auth-sessions', id: token.sessionId, overrideAccess: true })
      sessionActive = !session.revokedAt && new Date(session.expiresAt).getTime() > Date.now() && (typeof session.user === 'string' ? session.user : session.user?.id) === token.userId
    } catch { sessionActive = false }
    const body = !token || !sessionActive ? { active: false } : { active: true, clientId: token.clientId, userId: token.userId, sessionId: token.sessionId, scopes: token.scopes, resource: token.resource ?? input.resource, expiresAt: token.expiresAt ?? Math.floor(Date.now() / 1000) + 300 }
    outgoing.writeHead(200, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify(body))
  })
  oauthServer = oauth.server; oauthOrigin = oauth.origin
  process.env.OAUTH_INTERNAL_ORIGIN = oauthOrigin
  process.env.OAUTH_INTROSPECTION_SECRET = 'mcp-sdk-secret'
  const mcp = await startServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    await respond(outgoing, await handleMcp(requestFrom(incoming, mcpOrigin, Buffer.concat(chunks))))
  })
  mcpServer = mcp.server; mcpOrigin = mcp.origin
  process.env.PAYLOAD_PUBLIC_SERVER_URL = mcpOrigin
})

afterAll(async () => {
  await payload?.destroy()
  await Promise.all([mcpServer, oauthServer].filter(Boolean).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  rmSync(directory, { recursive: true, force: true })
  delete process.env.DATABASE_URI; delete process.env.PAYLOAD_SECRET; delete process.env.PAYLOAD_PUBLIC_SERVER_URL; delete process.env.OAUTH_INTERNAL_ORIGIN; delete process.env.OAUTH_INTROSPECTION_SECRET
})

test('real MCP SDK clients receive bounded allowed content and remain isolated', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: 'mcp-editor@example.test', name: 'MCP Editor', roles: ['editor'] }, overrideAccess: true })
  const qualityWriter = await payload.create({ collection: 'users', data: { email: 'mcp-quality-writer@example.test', name: 'MCP Quality Writer', roles: ['editor'] }, overrideAccess: true })
  const approver = await payload.create({ collection: 'users', data: { email: 'mcp-approver@example.test', name: 'MCP Approver', roles: ['approver'] }, overrideAccess: true })
  const owner = await payload.create({ collection: 'users', data: { email: 'mcp-owner@example.test', name: 'MCP Owner', roles: ['owner'] }, overrideAccess: true })
  const sales = await payload.create({ collection: 'users', data: { email: 'mcp-sales@example.test', name: 'MCP Sales', roles: ['sales'] }, overrideAccess: true })
  const hiring = await payload.create({ collection: 'users', data: { email: 'mcp-hiring@example.test', name: 'MCP Hiring', roles: ['hiring'] }, overrideAccess: true })
  const mutableGuide = await payload.create({ collection: 'style-guides', data: { bannedPhrases: ['synthetic banned phrase'], preferredTerms: [{ avoid: 'color', prefer: 'colour' }], canadianSpelling: 'warn', maximumSentenceWords: 24, minimumReadingEase: 40 }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
  const section = await payload.create({ collection: 'sections', data: { name: 'MCP', summary: 'A synthetic section used to verify MCP returns bounded editorial content.', slug: 'mcp', allowedTemplates: ['standard', 'article'] }, user: editor, overrideAccess: false })
  const page = await payload.create({ collection: 'pages', data: { title: 'SDK page', summary: 'A synthetic page used to verify the real MCP SDK client receives blocks.', slug: 'sdk-page', sectionId: section.id, template: 'standard', blocks: [{ id: '11111111-1111-4111-8111-111111111111', type: 'hero', heading: 'MCP block', body: 'This block must be present in a bounded MCP response.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, user: editor, overrideAccess: false })
  const qualityPage = await payload.create({ collection: 'pages', data: { title: 'Quality SDK page', summary: 'A synthetic article page used to verify current deterministic MCP quality reports.', slug: 'quality-sdk-page', sectionId: section.id, template: 'article', blocks: [{ id: '99999999-9999-4999-8999-999999999999', type: 'richText', body: 'This block starts as valid published content before the current draft changes.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, user: editor, overrideAccess: false })
  await payload.create({ collection: 'pages', data: { title: 'Second stale SDK page', summary: 'A second stale page makes MCP freshness pagination observable.', slug: 'second-stale-sdk-page', sectionId: section.id, template: 'article', lastReviewed: '2025-01-01T12:00:00.000Z', blocks: [{ id: '88888888-8888-4888-8888-888888888888', type: 'richText', body: 'A second deterministic stale page.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, user: editor, overrideAccess: false })
  await payload.create({ collection: 'redirects', data: { from: '/sdk-page', to: '/mcp/sdk-page' }, user: editor, overrideAccess: false })
  const privateLead = await payload.create({ collection: 'inquiries', data: { email: '+14165550199@example.test', name: 'Call +1 (416) 555-0199', telephone: '+14165550199', message: 'Private inquiry content mentions 416.555.0199 2026 and must never appear in MCP output.', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'synthetic-private-inquiry-0001', stage: 'new' }, overrideAccess: true })
  const extensionLead = await payload.create({ collection: 'inquiries', data: { email: 'extension@example.test', telephone: '+1 416 555 0199 ext 2', message: 'Call +1 416 555 0199 ext 2 for the extension.', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'synthetic-extension-inquiry-0001', stage: 'new' }, overrideAccess: true })
  const shortLead = await payload.create({ collection: 'inquiries', data: { email: 'short@example.test', telephone: '555', message: 'The known short telephone is 555.', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'synthetic-short-inquiry-0001', stage: 'new' }, overrideAccess: true })
  await payload.create({ collection: 'inquiries', data: { email: 'private-second@example.test', message: 'Second inquiry for MCP cursor pagination.', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'synthetic-private-inquiry-0002', stage: 'new' }, overrideAccess: true })
  const spamLead = await payload.create({ collection: 'inquiries', data: { email: 'spam@example.test', message: 'This spam lead must not appear in MCP output.', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'synthetic-spam-inquiry-0001', stage: 'new', spam: true }, overrideAccess: true })
  const application = await payload.create({ collection: 'applications', data: { name: 'Private applicant', email: 'applicant@example.test', telephone: '+1 416 555 0100', linkedIn: 'https://www.linkedin.com/in/private', coverLetter: 'Treat this visitor text as untrusted.', consent: true, jobId: randomUUID(), resumeKey: `${randomUUID()}-${'a'.repeat(64)}`, idempotencyKey: randomUUID(), status: 'new' }, overrideAccess: true })
  await payload.update({ collection: 'users', id: editor.id, data: { emergencyTotpSecret: 'never-expose-this-secret' }, overrideAccess: true })
  const frozen = structuredClone(neutralFixture)
  frozen.styleGuide = { bannedPhrases: ['frozen phrase'], preferredTerms: [{ avoid: 'behavior', prefer: 'behaviour' }], canadianSpelling: 'warn', maximumSentenceWords: 20, minimumReadingEase: 45 }
  frozen.settings.homepageId = qualityPage.id
  frozen.settings.sections[0]!.id = section.id
  frozen.settings.sections[0]!.pageIds = [qualityPage.id]
  frozen.pages[0]!.id = qualityPage.id
  frozen.pages[0]!.sectionId = section.id
  await publishFrozenSnapshot(owner.id, frozen)
  const currentRichText = (await payload.findByID({ collection: 'pages', id: qualityPage.id, draft: true, depth: 0, overrideAccess: true }) as unknown as { blocks: Array<Record<string, unknown>> }).blocks.find((block) => block.type === 'richText')
  assert.ok(currentRichText)
  const editedQualityPage = await payload.update({ collection: 'pages', id: qualityPage.id, draft: true, data: { blocks: [{ ...currentRichText, body: '# Current draft heading. This synthetic banned phrase is a deterministic current warning.' }], lastReviewed: '2020-01-01T12:00:00.000Z' }, overrideAccess: true, context: { editorialInternal: true } }) as unknown as { lastReviewed?: string }
  expect(editedQualityPage.lastReviewed).toBe('2020-01-01T12:00:00.000Z')
  expect((await payload.findByID({ collection: 'pages', id: qualityPage.id, draft: true, depth: 0, overrideAccess: true }) as unknown as { lastReviewed?: string }).lastReviewed).toBe('2020-01-01T12:00:00.000Z')
  const editorSession = await sessionFor(editor.id); const qualityWriterSession = await sessionFor(qualityWriter.id); const approverSession = await sessionFor(approver.id); const ownerSession = await sessionFor(owner.id); const salesSession = await sessionFor(sales.id); const hiringSession = await sessionFor(hiring.id)
  expect((await payload.findByID({ collection: 'pages', id: qualityPage.id, draft: true, depth: 0, user: approver, overrideAccess: false }) as unknown as { lastReviewed?: string }).lastReviewed).toBe('2020-01-01T12:00:00.000Z')
  tokens.set('editor-token', { clientId: 'editor-client', userId: editor.id, sessionId: editorSession.id, scopes: ['mcp:content:read', 'mcp:content:write', 'mcp:redirects:read'] })
  tokens.set('quality-writer-token', { clientId: 'quality-writer-client', userId: qualityWriter.id, sessionId: qualityWriterSession.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  tokens.set('approver-token', { clientId: 'approver-client', userId: approver.id, sessionId: approverSession.id, scopes: ['mcp:content:read'] })
  tokens.set('owner-token', { clientId: 'owner-client', userId: owner.id, sessionId: ownerSession.id, scopes: ['mcp:content:read'] })
  tokens.set('owner-personal-token', { clientId: 'owner-personal-client', userId: owner.id, sessionId: ownerSession.id, scopes: ['mcp:content:read', 'mcp:leads:read', 'mcp:careers:read'] })
  tokens.set('sales-token', { clientId: 'sales-client', userId: sales.id, sessionId: salesSession.id, scopes: ['mcp:leads:read'] }); tokens.set('sales-reply-token', { clientId: 'sales-reply-client', userId: sales.id, sessionId: salesSession.id, scopes: ['mcp:leads:read', 'mcp:leads:reply'] }); tokens.set('sales-write-token', { clientId: 'sales-write-client', userId: sales.id, sessionId: salesSession.id, scopes: ['mcp:leads:read', 'mcp:leads:write'] }); tokens.set('hiring-token', { clientId: 'hiring-client', userId: hiring.id, sessionId: hiringSession.id, scopes: ['mcp:careers:read'] })
  await payload.create({ collection: 'site-settings', data: { siteName: 'MCP site', legalName: 'MCP Site Incorporated', defaultLocale: 'en-CA', homepageId: page.id, address: { streetAddress: '100 Example Road', addressLocality: 'Toronto', addressRegion: 'ON', postalCode: 'M5V 2T6', addressCountry: 'CA' }, linkedIn: 'https://www.linkedin.com/company/mcp-site', incident: { label: 'Incident in progress?', guidance: 'Use the published incident line.' }, seoDescription: 'Synthetic owner-only site metadata returned through the bounded MCP resource.', crawlerPolicy: { searchEngines: true, aiSearchAndAnswers: false, aiModelTraining: false }, navigation: { header: [{ kind: 'page', id: page.id, label: 'SDK page', style: 'link' }, { kind: 'unavailable', label: 'Unavailable', reason: 'Synthetic unavailable navigation reference.', style: 'link' }], footer: { columns: [{ kind: 'links', heading: 'Resources', links: [{ kind: 'page', id: page.id, label: 'SDK page' }, { kind: 'unavailable', label: 'Unavailable', reason: 'Synthetic unavailable footer reference.' }] }], copyright: '© {year} MCP' } } }, draft: true, user: owner, overrideAccess: false })
  const editorClient = await clientFor('editor-token'); const qualityWriterClient = await clientFor('quality-writer-token'); const approverClient = await clientFor('approver-token'); const ownerClient = await clientFor('owner-token'); const ownerPersonalClient = await clientFor('owner-personal-token'); const salesClient = await clientFor('sales-token'); const salesReplyClient = await clientFor('sales-reply-token'); const salesWriteClient = await clientFor('sales-write-token'); const hiringClient = await clientFor('hiring-token')
  try {
    const editorTools = await editorClient.client.listTools(); expect(editorTools.tools.map((tool) => tool.name).sort()).toEqual(expect.arrayContaining(['add_block', 'add_item', 'audit_page', 'copy_block', 'create_change_set', 'create_page', 'create_page_from_recipe', 'create_section', 'get_application', 'get_block_library', 'get_change_set', 'get_lead', 'get_page', 'get_page_quality', 'get_reply_status', 'get_site_settings', 'get_style_guide', 'get_tree', 'hide_block', 'list_appearance_options', 'list_applications', 'list_block_types', 'list_installed_themes', 'list_leads', 'list_redirects', 'list_section_presets', 'list_sections', 'list_stale_pages', 'list_templates', 'move_block', 'move_item', 'prepare_reply', 'remove_block', 'remove_item', 'reorder_blocks', 'search_content', 'search_pages', 'send_reply', 'submit_change_set', 'update_block', 'update_item', 'update_page', 'update_page_fields', 'update_section']))
    expect(editorTools.tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(['approve_change_set', 'publish']))
    for (const tool of editorTools.tools) {
      if (!['list_leads', 'get_lead', 'list_inquiries', 'get_inquiry', 'update_inquiry', 'update_lead', 'get_lead_emails', 'list_follow_ups', 'record_reply', 'list_applications', 'get_application', 'update_application', 'prepare_reply', 'send_reply', 'get_reply_status'].includes(tool.name)) { expect(tool.description).toContain('cannot publish'); expect(tool.description).toContain('approve'); expect(tool.description).toContain('manage users'); expect(tool.description).toContain('permanently delete content') }
      if (!['request_rollback', 'create_change_set', 'submit_change_set', 'start_change_set', 'submit_for_review', 'discard_change_set', 'create_page', 'create_page_from_recipe', 'create_section', 'update_section', 'archive_section', 'duplicate_page', 'move_page', 'change_page_template', 'archive_page', 'update_page', 'update_page_fields', 'update_block', 'update_media', 'add_block', 'move_block', 'hide_block', 'copy_block', 'remove_block', 'reorder_blocks', 'add_item', 'update_item', 'move_item', 'remove_item', 'update_inquiry', 'update_lead', 'record_reply', 'update_application', 'prepare_reply', 'send_reply'].includes(tool.name)) expect(tool.annotations?.readOnlyHint).toBe(true)
      if (['prepare_reply', 'send_reply', 'get_reply_status'].includes(tool.name)) expect(tool._meta).toMatchObject({ securitySchemes: [expect.objectContaining({ type: 'oauth2', scopes: ['mcp:leads:read', 'mcp:leads:reply'] }), expect.objectContaining({ type: 'oauth2', scopes: ['mcp:careers:read', 'mcp:careers:reply'] })], authorization: expect.objectContaining({ effectiveUserRequired: true }) })
      else expect(tool._meta).toMatchObject({ securitySchemes: [expect.objectContaining({ type: 'oauth2' })], authorization: expect.objectContaining({ effectiveUserRequired: true }) })
    }
    for (const name of ['list_leads', 'get_lead']) expect(editorTools.tools.find((tool) => tool.name === name)?._meta).toMatchObject({ securitySchemes: [{ type: 'oauth2', scopes: ['mcp:leads:read'] }], authorization: { requiredScopes: ['mcp:leads:read'] } })
    for (const name of ['list_applications', 'get_application']) expect(editorTools.tools.find((tool) => tool.name === name)?._meta).toMatchObject({ securitySchemes: [{ type: 'oauth2', scopes: ['mcp:careers:read'] }], authorization: { requiredScopes: ['mcp:careers:read'] } })
    for (const name of ['list_leads', 'list_applications', 'get_lead', 'get_application']) expect(editorTools.tools.find((tool) => tool.name === name)?.outputSchema).toBeDefined()
    expect((await salesClient.client.listTools()).tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'list_leads' })]))
    await expect(salesClient.client.listResources()).rejects.toMatchObject({ code: 403 })
    await expect(salesClient.client.callTool({ name: 'get_tree', arguments: {} })).rejects.toMatchObject({ code: 403 })
    const [resources, templates, prompts] = await Promise.all([editorClient.client.listResources(), editorClient.client.listResourceTemplates(), editorClient.client.listPrompts()])
    expect(resources.resources.map((entry) => entry.uri).sort()).toEqual(expect.arrayContaining([
      'site-engine://contract/block-library', 'site-engine://contract/glossary', 'site-engine://contract/style-guide', 'site-engine://site/installed-themes', 'site-engine://site/page-tree', 'site-engine://site/settings', 'site-engine://site/summary', `site-engine://page/${page.id}`,
    ]))
    expect(templates.resourceTemplates).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'page', uriTemplate: 'site-engine://page/{id}' })]))
    expect(prompts.prompts.map((prompt) => prompt.name).sort()).toEqual(['plan-page', 'review-content'])
    for (const entry of [...resources.resources, ...templates.resourceTemplates]) {
      expect(entry._meta).toMatchObject({
        securitySchemes: [{ type: 'oauth2', scopes: ['mcp:content:read'] }],
        authorization: { requiredScopes: ['mcp:content:read'], effectiveUserRequired: true },
        limits: { approve: false, publish: false, userManagement: false, credentialAccess: false },
      })
    }
    for (const prompt of prompts.prompts) expect(prompt.description).toContain('cannot publish, approve, manage users, permanently delete content')
    for (const uri of ['site-engine://site/settings', 'site-engine://site/installed-themes']) expect(resources.resources.find((entry) => entry.uri === uri)?._meta).toMatchObject({ authorization: { requiredRoles: ['owner'] } })
    const [library, configuredStyle, scopedPage, planned] = await Promise.all([
      editorClient.client.readResource({ uri: 'site-engine://contract/block-library' }),
      editorClient.client.readResource({ uri: 'site-engine://contract/style-guide' }),
      editorClient.client.readResource({ uri: `site-engine://page/${page.id}` }),
      editorClient.client.getPrompt({ name: 'plan-page', arguments: { objective: 'Explain the synthetic service.' } }),
    ])
    expect(resourceJson(library)).toMatchObject({ contractVersion: CONTRACT_VERSION, blockTypes: expect.arrayContaining(['hero', 'video']) })
    expect(resourceJson(configuredStyle)).toMatchObject({ source: 'frozen-published-snapshot', bannedPhrases: ['frozen phrase'], canadianSpelling: 'warn' })
    expect(resourceJson(await editorClient.client.readResource({ uri: 'site-engine://contract/glossary' }))).toMatchObject({ source: 'frozen-published-snapshot', terms: [{ avoid: 'behavior', prefer: 'behaviour' }] })
    expect(resourceJson(scopedPage)).toMatchObject({ id: page.id, title: 'SDK page' })
    const [tree, blockTypes, templateCatalog, presets, appearance, search] = await Promise.all([
      editorClient.client.callTool({ name: 'get_tree', arguments: {} }),
      editorClient.client.callTool({ name: 'list_block_types', arguments: {} }),
      editorClient.client.callTool({ name: 'list_templates', arguments: {} }),
      editorClient.client.callTool({ name: 'list_section_presets', arguments: {} }),
      editorClient.client.callTool({ name: 'list_appearance_options', arguments: {} }),
      editorClient.client.callTool({ name: 'search_content', arguments: { query: 'synthetic' } }),
    ])
    expect(structuredJson(tree)).toMatchObject({ sections: expect.arrayContaining([expect.objectContaining({ id: section.id, slug: 'mcp' })]), pages: expect.arrayContaining([expect.objectContaining({ id: page.id, template: 'standard', status: expect.any(String) })]) })
    expect(structuredJson(blockTypes)).toMatchObject({ blockTypes: expect.arrayContaining([expect.objectContaining({ type: 'hero', allowedTemplates: expect.arrayContaining(['standard']) })]) })
    expect(structuredJson(templateCatalog)).toEqual({ templates: TemplateSchema.options.map((template) => ({ template, allowedBlocks: [...TemplateAllowedBlocks[template]] })) })
    expect(structuredJson(presets)).toEqual({ presets: SectionPresets })
    expect(structuredJson(appearance)).toEqual({ appearance: AppearanceOptions })
    expect(structuredJson(search)).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: page.id, title: 'SDK page' })]) })
    await expect(editorClient.client.callTool({ name: 'list_templates', arguments: { unknown: true } })).resolves.toMatchObject({ isError: true })
    const [pageAudit, editablePageAudit, stalePages, publishedStyle] = await Promise.all([
      approverClient.client.callTool({ name: 'audit_page', arguments: { id: qualityPage.id } }),
      approverClient.client.callTool({ name: 'audit_page', arguments: { id: page.id } }),
      approverClient.client.callTool({ name: 'list_stale_pages', arguments: {} }),
      approverClient.client.callTool({ name: 'get_style_guide', arguments: {} }),
    ])
    const auditValue = structuredJson(pageAudit) as { pageHash: string; contentHash: string }
    expect(auditValue).toMatchObject({ pageHash: expect.stringMatching(/^[a-f0-9]{64}$/), contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(auditValue.pageHash).not.toBe(auditValue.contentHash)
    expect(structuredJson(pageAudit)).toMatchObject({ source: 'current-editable-draft', pageId: qualityPage.id, publishable: false, blockers: [expect.objectContaining({ code: 'HEADING_H1_COUNT', severity: 'blocker' })], warnings: expect.arrayContaining([expect.objectContaining({ code: 'STYLE_BANNED_PHRASE', severity: 'warning' })]) })
    const currentContractBlockers = (structuredJson(pageAudit) as { blockers: Array<{ message: string }> }).blockers.map((item) => item.message)
    expect(currentContractBlockers).not.toEqual(expect.arrayContaining([expect.stringContaining('contract version')]))
    expect(CONTRACT_VERSION).toBe('1.7.0')
    expect(structuredJson(stalePages)).toMatchObject({ source: 'current-editable-draft', items: expect.arrayContaining([expect.objectContaining({ id: qualityPage.id, reviewAgeDays: expect.any(Number) })]), page: 1, nextCursor: null })
    const staleFirst = structuredJson(await approverClient.client.callTool({ name: 'list_stale_pages', arguments: { limit: 1 } })) as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(staleFirst.nextCursor).toBe('p:2')
    const staleSecond = structuredJson(await approverClient.client.callTool({ name: 'list_stale_pages', arguments: { limit: 1, cursor: staleFirst.nextCursor } })) as { items: Array<{ id: string }>; page: number; nextCursor: string | null }
    expect(staleSecond).toMatchObject({ page: 2, nextCursor: null })
    expect(staleSecond.items[0]?.id).not.toBe(staleFirst.items[0]?.id)
    const editableAuditValue = structuredJson(editablePageAudit) as { pageHash: string }
    const qualitySet = resultJson(await qualityWriterClient.client.callTool({ name: 'create_change_set', arguments: { name: 'Audit hash page edit' } })) as { id: string; revision: number }
    expect(structuredJson(await qualityWriterClient.client.callTool({ name: 'update_page_fields', arguments: { pageId: page.id, changeSetId: qualitySet.id, expectedChangeSetRevision: qualitySet.revision, expectedPageHash: editableAuditValue.pageHash, fields: { title: 'SDK page audit hash accepted' } } }))).toMatchObject({ draft: { pageId: page.id } })
    expect(structuredJson(publishedStyle)).toEqual({ source: 'current-editable-draft', bannedPhrases: ['synthetic banned phrase'], preferredTerms: [{ avoid: 'color', prefer: 'colour' }], canadianSpelling: 'warn', maximumSentenceWords: 24, minimumReadingEase: 40 })
    await expect(approverClient.client.callTool({ name: 'audit_page', arguments: { id: qualityPage.id, unknown: true } })).resolves.toMatchObject({ isError: true })
    await expect(salesClient.client.callTool({ name: 'list_stale_pages', arguments: {} })).rejects.toMatchObject({ code: 403 })
    await expect(ownerClient.client.callTool({ name: 'list_leads', arguments: {} })).rejects.toMatchObject({ code: 403 })
    await expect(editorClient.client.callTool({ name: 'list_leads', arguments: {} })).rejects.toMatchObject({ code: 403 })
    const firstLeadResult = await ownerPersonalClient.client.callTool({ name: 'list_leads', arguments: { limit: 1 } })
    const firstLeadPage = structuredJson(firstLeadResult) as { items: Array<Record<string, unknown>>; page: number; nextCursor: string | null }
    expect(firstLeadPage).toMatchObject({ items: [expect.any(Object)], page: 1, nextCursor: 'p:2' })
    const secondLeadResult = await ownerPersonalClient.client.callTool({ name: 'list_leads', arguments: { limit: 1, cursor: firstLeadPage.nextCursor! } })
    const secondLeadPage = structuredJson(secondLeadResult) as { items: Array<Record<string, unknown>>; page: number }
    const leads = (structuredJson(await ownerPersonalClient.client.callTool({ name: 'list_leads', arguments: { limit: 25 } })) as { items: Array<Record<string, unknown>> }).items
    expect(secondLeadPage).toMatchObject({ page: 2 }); expect(secondLeadPage.items[0]?.id).not.toBe(firstLeadPage.items[0]?.id)
    expect(leads).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: spamLead.id })]))
    expect(leads[0]).toMatchObject({ visitor: expect.objectContaining({ untrusted: true }), consent: { basis: 'visitor-confirmed', at: expect.any(String) }, message: expect.objectContaining({ untrusted: true }) }); expect(JSON.stringify(leads[0])).not.toContain('idempotencyKey')
    const hiddenLead = resultJson(await ownerPersonalClient.client.callTool({ name: 'get_lead', arguments: { id: privateLead.id } })) as { visitor: { phone: string | null; email: string | null; name: string; topic: string }; message: { text: string } }
    expect(hiddenLead.visitor.phone).toBeNull()
    expect(hiddenLead.visitor.email).toBeNull()
    expect(JSON.stringify([hiddenLead.visitor, hiddenLead.message])).not.toContain('416')
    expect(hiddenLead.message.text).toContain('2026')
    for (const [id, phone] of [[extensionLead.id, '+1 416 555 0199 ext 2'], [shortLead.id, '555']] as const) {
      const lead = resultJson(await ownerPersonalClient.client.callTool({ name: 'get_lead', arguments: { id } })) as { visitor: unknown; message: unknown }
      expect(JSON.stringify([lead.visitor, lead.message])).not.toContain(phone)
    }
    await payload.create({ collection: 'mcp-privacy-settings', data: { key: 'active', hidePhone: false }, overrideAccess: true })
    const visibleLead = resultJson(await ownerPersonalClient.client.callTool({ name: 'get_lead', arguments: { id: privateLead.id } })) as { visitor: { phone: string | null }; message: { text: string } }
    expect(visibleLead.visitor.phone).toBe('+14165550199')
    expect(visibleLead.message.text).toContain('416.555.0199')
    const inquiry = structuredJson(await salesWriteClient.client.callTool({ name: 'get_inquiry', arguments: { id: privateLead.id } })) as { id: string; updatedAt: string }
    await expect(salesClient.client.callTool({ name: 'update_inquiry', arguments: { id: inquiry.id, expectedUpdatedAt: inquiry.updatedAt, stage: 'contacted' } })).rejects.toMatchObject({ code: 403 })
    await expect(salesReplyClient.client.callTool({ name: 'update_inquiry', arguments: { id: inquiry.id, expectedUpdatedAt: inquiry.updatedAt, stage: 'contacted' } })).rejects.toMatchObject({ code: 403 })
    expect(structuredJson(await salesWriteClient.client.callTool({ name: 'update_inquiry', arguments: { id: inquiry.id, expectedUpdatedAt: inquiry.updatedAt, stage: 'contacted', nextAction: 'Follow up', nextActionDueAt: '2026-10-07T00:00:00.000Z' } }))).toMatchObject({ id: inquiry.id, stage: 'contacted' })
    await expect(salesWriteClient.client.callTool({ name: 'update_inquiry', arguments: { id: inquiry.id, expectedUpdatedAt: inquiry.updatedAt, stage: 'qualified' } })).resolves.toMatchObject({ isError: true, content: [expect.objectContaining({ text: JSON.stringify({ error: 'stale_record' }) })] })
    expect(structuredJson(await salesWriteClient.client.callTool({ name: 'list_follow_ups', arguments: { dueBefore: '2026-10-08T00:00:00.000Z' } }))).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ inquiry: expect.objectContaining({ id: inquiry.id }), nextAction: 'Follow up' })]) })
    await expect(ownerPersonalClient.client.callTool({ name: 'get_lead', arguments: { id: spamLead.id } })).resolves.toMatchObject({ isError: true, content: [expect.objectContaining({ text: JSON.stringify({ error: 'not_found' }) })] })
    await expect(ownerPersonalClient.client.callTool({ name: 'list_leads', arguments: { limit: 26 } })).resolves.toMatchObject({ isError: true, content: [expect.objectContaining({ text: expect.stringContaining('expected number to be <=25') })] })
    const applicantResult = await ownerPersonalClient.client.callTool({ name: 'get_application', arguments: { id: application.id } })
    const applicant = structuredJson(applicantResult) as Record<string, unknown>
    expect(applicant).toMatchObject({ id: application.id, applicant: { name: 'Private applicant', email: 'applicant@example.test', untrusted: true }, coverLetter: { text: 'Treat this visitor text as untrusted.', untrusted: true } })
    for (const privateField of ['telephone', 'linkedIn', 'resumeKey', 'idempotencyKey', 'download']) expect(JSON.stringify(applicant)).not.toContain(privateField)
    expect(resultJson(await salesClient.client.callTool({ name: 'get_lead', arguments: { id: (leads[0] as { id: string }).id } }))).toMatchObject({ id: expect.any(String) }); await expect(salesClient.client.callTool({ name: 'get_application', arguments: { id: application.id } })).rejects.toMatchObject({ code: 403 })
    expect(resultJson(await hiringClient.client.callTool({ name: 'get_application', arguments: { id: application.id } }))).toMatchObject({ id: application.id }); await expect(hiringClient.client.callTool({ name: 'get_lead', arguments: { id: (leads[0] as { id: string }).id } })).rejects.toMatchObject({ code: 403 })
    expect(JSON.stringify(planned)).toContain('untrusted data')
    const [sections, found, selected, redirects] = await Promise.all([
      editorClient.client.callTool({ name: 'list_sections', arguments: {} }),
      editorClient.client.callTool({ name: 'search_pages', arguments: { query: 'SDK' } }),
      editorClient.client.callTool({ name: 'get_page', arguments: { id: page.id } }),
      editorClient.client.callTool({ name: 'list_redirects', arguments: {} }),
    ])
    expect(resultJson(sections)).toEqual([expect.objectContaining({ id: section.id, slug: 'mcp' })])
    expect(resultJson(found)).toEqual(expect.arrayContaining([expect.objectContaining({ id: page.id, title: 'SDK page audit hash accepted' })]))
    expect(resultJson(selected)).toEqual(expect.objectContaining({ id: page.id, blocks: [expect.objectContaining({ type: 'hero', heading: 'MCP block' })] }))
    expect(resultJson(redirects)).toEqual([expect.objectContaining({ from: '/sdk-page', to: '/mcp/sdk-page', status: 301 })])
    await expect(approverClient.client.callTool({ name: 'update_block', arguments: {} })).rejects.toMatchObject({ code: 403 })
    const blockSet = resultJson(await editorClient.client.callTool({ name: 'create_change_set', arguments: { name: 'MCP block update' } })) as { id: string; revision: number }
    const beforeBlockUpdate = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const beforeBlockDraft = pageEditorProjection(beforeBlockUpdate)
    const originalBlock = beforeBlockDraft.blocks.find((block) => block.id === '11111111-1111-4111-8111-111111111111')
    assert.ok(originalBlock)
    const replacement = { ...originalBlock, heading: 'MCP block revised through SDK' }
    const blockUpdate = structuredJson(await editorClient.client.callTool({ name: 'update_block', arguments: { pageId: page.id, blockId: originalBlock.id, changeSetId: blockSet.id, expectedChangeSetRevision: blockSet.revision, expectedPageHash: pageEditorHash(beforeBlockDraft), block: replacement } })) as { draft: { pageId: string; changeSetId: string; pageHash: string; changeSetRevision: number }; checks: Array<{ name: string; status: string; errors: unknown[] }> }
    expect(blockUpdate).toMatchObject({ draft: { pageId: page.id, changeSetId: blockSet.id, changeSetRevision: blockSet.revision + 1 }, checks: [{ name: 'contract-and-tree', status: 'passed', errors: [] }] })
    const afterBlockUpdate = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    expect(pageEditorProjection(afterBlockUpdate).blocks).toEqual(expect.arrayContaining([expect.objectContaining({ id: originalBlock.id, heading: 'MCP block revised through SDK' })]))
    const blockAudit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'mcp.tool_result' } }, overrideAccess: true, limit: 100 })
    const blockAuditEvent = blockAudit.docs.find((event) => (event.detail as Record<string, unknown> | undefined)?.tool === 'update_block')
    expect(blockAuditEvent).toMatchObject({
      user: expect.objectContaining({ id: editor.id }),
      actor: expect.objectContaining({ id: editor.id }),
      detail: expect.objectContaining({
        clientIdHash: expect.any(String), tool: 'update_block', scopes: ['mcp:content:read', 'mcp:content:write', 'mcp:redirects:read'], result: 'draft_saved',
        batch: { pageId: page.id, blockId: originalBlock.id, changeSetId: blockSet.id },
        diff: { blocks: [expect.objectContaining({ id: originalBlock.id, before: expect.objectContaining({ heading: 'MCP block' }), after: expect.objectContaining({ heading: 'MCP block revised through SDK' }) })] },
      }),
    })
    expect(JSON.stringify(blockAuditEvent)).not.toContain('editor-client')
    const beforeStale = pageEditorProjection(afterBlockUpdate)
    const setAfterUpdate = await payload.findByID({ collection: 'change-sets', id: blockSet.id, depth: 0, overrideAccess: true }) as { revision: number }
    const staleResult = resultJson(await editorClient.client.callTool({ name: 'update_block', arguments: { pageId: page.id, blockId: originalBlock.id, changeSetId: blockSet.id, expectedChangeSetRevision: setAfterUpdate.revision, expectedPageHash: '0'.repeat(64), block: { ...replacement, heading: 'stale hash must not persist' } } }))
    expect(staleResult).toEqual({ error: 'stale_page_edit' })
    const afterStale = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const setAfterStale = await payload.findByID({ collection: 'change-sets', id: blockSet.id, depth: 0, overrideAccess: true }) as { revision: number }
    expect(pageEditorProjection(afterStale)).toEqual(beforeStale)
    expect(setAfterStale.revision).toBe(setAfterUpdate.revision)
    const nestedUnknownResult = resultJson(await editorClient.client.callTool({ name: 'update_block', arguments: { pageId: page.id, blockId: originalBlock.id, changeSetId: blockSet.id, expectedChangeSetRevision: setAfterStale.revision, expectedPageHash: pageEditorHash(beforeStale), block: { ...replacement, appearance: { ...replacement.appearance, unexpectedNestedField: true } } } }))
    expect(nestedUnknownResult).toEqual({ error: 'write_failed' })
    const afterNestedUnknown = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    expect(pageEditorProjection(afterNestedUnknown)).toEqual(beforeStale)
    const structuralSet = resultJson(await editorClient.client.callTool({ name: 'create_change_set', arguments: { name: 'MCP structural blocks' } })) as { id: string; revision: number }
    const beforeAdd = pageEditorProjection(afterNestedUnknown)
    const addResult = structuredJson(await editorClient.client.callTool({ name: 'add_block', arguments: { pageId: page.id, changeSetId: structuralSet.id, expectedChangeSetRevision: structuralSet.revision, expectedPageHash: pageEditorHash(beforeAdd), index: 1, block: { type: 'callout' } } })) as { draft: { pageHash: string; changeSetRevision: number }; checks: Array<{ name: string; status: string }> }
    expect(addResult).toMatchObject({ draft: { changeSetRevision: structuralSet.revision + 1 }, checks: [{ name: 'contract-and-tree', status: 'passed' }] })
    const afterAddRecord = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const afterAdd = pageEditorProjection(afterAddRecord)
    const added = afterAdd.blocks.find((block) => block.type === 'callout')
    assert.ok(added)
    const setAfterAdd = await payload.findByID({ collection: 'change-sets', id: structuralSet.id, depth: 0, overrideAccess: true }) as { revision: number }
    const invalidReorder = resultJson(await editorClient.client.callTool({ name: 'reorder_blocks', arguments: { pageId: page.id, changeSetId: structuralSet.id, expectedChangeSetRevision: setAfterAdd.revision, expectedPageHash: pageEditorHash(afterAdd), blockIds: [added.id, added.id] } }))
    expect(invalidReorder).toEqual({ error: 'invalid_order' })
    const afterInvalidReorder = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    expect(pageEditorProjection(afterInvalidReorder)).toEqual(afterAdd)
    await expect(editorClient.client.callTool({ name: 'add_block', arguments: { pageId: page.id, changeSetId: structuralSet.id, expectedChangeSetRevision: setAfterAdd.revision, expectedPageHash: pageEditorHash(afterAdd), index: 2, block: { type: 'media' } } })).resolves.toMatchObject({ isError: true })
    const afterForbiddenAdd = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    expect(pageEditorProjection(afterForbiddenAdd)).toEqual(afterAdd)
    const reorderResult = structuredJson(await editorClient.client.callTool({ name: 'reorder_blocks', arguments: { pageId: page.id, changeSetId: structuralSet.id, expectedChangeSetRevision: setAfterAdd.revision, expectedPageHash: pageEditorHash(afterAdd), blockIds: [added.id, originalBlock.id] } })) as { draft: { changeSetRevision: number }; checks: Array<{ status: string }> }
    expect(reorderResult).toMatchObject({ draft: { changeSetRevision: setAfterAdd.revision + 1 }, checks: [{ status: 'passed' }] })
    const afterReorderRecord = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const afterReorder = pageEditorProjection(afterReorderRecord)
    expect(afterReorder.blocks.map((block) => block.id)).toEqual([added.id, originalBlock.id])
    const setAfterReorder = await payload.findByID({ collection: 'change-sets', id: structuralSet.id, depth: 0, overrideAccess: true }) as { revision: number }
    const removeResult = structuredJson(await editorClient.client.callTool({ name: 'remove_block', arguments: { pageId: page.id, changeSetId: structuralSet.id, expectedChangeSetRevision: setAfterReorder.revision, expectedPageHash: pageEditorHash(afterReorder), blockId: added.id } })) as { draft: { changeSetRevision: number }; checks: Array<{ status: string }> }
    expect(removeResult).toMatchObject({ draft: { changeSetRevision: setAfterReorder.revision + 1 }, checks: [{ status: 'passed' }] })
    const afterRemove = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    expect(pageEditorProjection(afterRemove).blocks.map((block) => block.id)).toEqual([originalBlock.id])
    const structuralAudit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'mcp.tool_result' } }, overrideAccess: true, limit: 100 })
    for (const tool of ['add_block', 'reorder_blocks', 'remove_block']) expect(structuralAudit.docs.find((event) => (event.detail as Record<string, unknown> | undefined)?.tool === tool)).toMatchObject({ detail: expect.objectContaining({ result: 'draft_saved', batch: expect.any(Object), diff: expect.any(Object) }) })
    const itemSet = resultJson(await editorClient.client.callTool({ name: 'create_change_set', arguments: { name: 'MCP list items' } })) as { id: string; revision: number }
    const beforeFaq = pageEditorProjection(afterRemove)
    const addFaq = structuredJson(await editorClient.client.callTool({ name: 'add_block', arguments: { pageId: page.id, changeSetId: itemSet.id, expectedChangeSetRevision: itemSet.revision, expectedPageHash: pageEditorHash(beforeFaq), index: 1, block: { type: 'faq' } } })) as { draft: { changeSetRevision: number } }
    const afterFaqRecord = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const afterFaq = pageEditorProjection(afterFaqRecord)
    const faq = afterFaq.blocks.find((block) => block.type === 'faq')
    assert.ok(faq)
    const addItem = structuredJson(await editorClient.client.callTool({ name: 'add_item', arguments: { pageId: page.id, changeSetId: itemSet.id, expectedChangeSetRevision: addFaq.draft.changeSetRevision, expectedPageHash: pageEditorHash(afterFaq), blockId: faq.id, index: 1, item: { question: 'Second SDK question?', answer: 'A second answer created through the MCP SDK item tool.' } } })) as { draft: { changeSetRevision: number }; checks: Array<{ status: string }> }
    expect(addItem).toMatchObject({ checks: [{ status: 'passed' }] })
    const afterAddItemRecord = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const afterAddItem = pageEditorProjection(afterAddItemRecord)
    const faqAfterAdd = afterAddItem.blocks.find((block) => block.id === faq.id) as typeof faq
    expect(faqAfterAdd.items).toHaveLength(2)
    const updateItem = structuredJson(await editorClient.client.callTool({ name: 'update_item', arguments: { pageId: page.id, changeSetId: itemSet.id, expectedChangeSetRevision: addItem.draft.changeSetRevision, expectedPageHash: pageEditorHash(afterAddItem), blockId: faq.id, index: 1, item: { question: 'Updated SDK question?', answer: 'The updated answer remains a valid FAQ item.' } } })) as { draft: { changeSetRevision: number } }
    const afterUpdateItemRecord = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const afterUpdateItem = pageEditorProjection(afterUpdateItemRecord)
    const moveItem = structuredJson(await editorClient.client.callTool({ name: 'move_item', arguments: { pageId: page.id, changeSetId: itemSet.id, expectedChangeSetRevision: updateItem.draft.changeSetRevision, expectedPageHash: pageEditorHash(afterUpdateItem), blockId: faq.id, fromIndex: 1, toIndex: 0 } })) as { draft: { changeSetRevision: number } }
    const afterMoveItemRecord = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const afterMoveItem = pageEditorProjection(afterMoveItemRecord)
    expect((afterMoveItem.blocks.find((block) => block.id === faq.id) as typeof faq).items[0]).toMatchObject({ question: 'Updated SDK question?' })
    const beforeInvalidItem = structuredClone(afterMoveItem)
    expect(resultJson(await editorClient.client.callTool({ name: 'update_item', arguments: { pageId: page.id, changeSetId: itemSet.id, expectedChangeSetRevision: moveItem.draft.changeSetRevision, expectedPageHash: pageEditorHash(afterMoveItem), blockId: faq.id, index: 9, item: { question: 'Invalid index?', answer: 'This must not persist.' } } }))).toEqual({ error: 'invalid_item_index' })
    await expect(editorClient.client.callTool({ name: 'add_item', arguments: { pageId: page.id, changeSetId: itemSet.id, expectedChangeSetRevision: moveItem.draft.changeSetRevision, expectedPageHash: pageEditorHash(afterMoveItem), blockId: faq.id, index: 2, item: { question: 'Unknown field?', answer: 'This must not persist.', unknown: true } } })).resolves.toMatchObject({ isError: true })
    expect(resultJson(await editorClient.client.callTool({ name: 'update_item', arguments: { pageId: page.id, changeSetId: itemSet.id, expectedChangeSetRevision: moveItem.draft.changeSetRevision, expectedPageHash: '0'.repeat(64), blockId: faq.id, index: 0, item: { question: 'Stale?', answer: 'This must not persist.' } } }))).toEqual({ error: 'stale_page_edit' })
    const afterRejectedItems = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    expect(pageEditorProjection(afterRejectedItems)).toEqual(beforeInvalidItem)
    const removeItem = structuredJson(await editorClient.client.callTool({ name: 'remove_item', arguments: { pageId: page.id, changeSetId: itemSet.id, expectedChangeSetRevision: moveItem.draft.changeSetRevision, expectedPageHash: pageEditorHash(afterMoveItem), blockId: faq.id, index: 1 } })) as { draft: { changeSetRevision: number }; checks: Array<{ status: string }> }
    expect(removeItem).toMatchObject({ checks: [{ status: 'passed' }] })
    const itemAudit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'mcp.tool_result' } }, overrideAccess: true, limit: 100 })
    for (const tool of ['add_item', 'update_item', 'move_item', 'remove_item']) expect(itemAudit.docs.find((event) => (event.detail as Record<string, unknown> | undefined)?.tool === tool)).toMatchObject({ detail: expect.objectContaining({ result: 'draft_saved', batch: expect.any(Object), diff: expect.any(Object) }) })
    const contentSet = resultJson(await editorClient.client.callTool({ name: 'create_change_set', arguments: { name: 'MCP documented content' } })) as { id: string; revision: number }
    const contentBeforeRecord = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const contentBefore = pageEditorProjection(contentBeforeRecord)
    const copied = structuredJson(await editorClient.client.callTool({ name: 'copy_block', arguments: { pageId: page.id, changeSetId: contentSet.id, expectedChangeSetRevision: contentSet.revision, expectedPageHash: pageEditorHash(contentBefore), sourcePageId: page.id, sourceBlockId: faq.id, index: 2 } })) as { draft: { changeSetRevision: number } }
    const afterCopyRecord = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const afterCopy = pageEditorProjection(afterCopyRecord); const copiedBlock = afterCopy.blocks[2]!; expect(copiedBlock.id).not.toBe(faq.id)
    const moved = structuredJson(await editorClient.client.callTool({ name: 'move_block', arguments: { pageId: page.id, changeSetId: contentSet.id, expectedChangeSetRevision: copied.draft.changeSetRevision, expectedPageHash: pageEditorHash(afterCopy), blockId: copiedBlock.id, toIndex: 1 } })) as { draft: { changeSetRevision: number } }
    const afterMoveRecord = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const afterMove = pageEditorProjection(afterMoveRecord)
    const hidden = structuredJson(await editorClient.client.callTool({ name: 'hide_block', arguments: { pageId: page.id, changeSetId: contentSet.id, expectedChangeSetRevision: moved.draft.changeSetRevision, expectedPageHash: pageEditorHash(afterMove), blockId: copiedBlock.id, hidden: true } })) as { draft: { changeSetRevision: number } }
    const afterHideRecord = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const afterHide = pageEditorProjection(afterHideRecord); expect(afterHide.blocks.find((block) => block.id === copiedBlock.id)?.hidden).toBe(true)
    const pageFieldsResult = structuredJson(await editorClient.client.callTool({ name: 'update_page_fields', arguments: { pageId: page.id, changeSetId: contentSet.id, expectedChangeSetRevision: hidden.draft.changeSetRevision, expectedPageHash: pageEditorHash(afterHide), fields: { title: 'SDK page revised fields' } } })) as { draft: { changeSetRevision: number } }
    const afterFieldsRecord = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const afterFields = pageEditorProjection(afterFieldsRecord); expect(afterFields.title).toBe('SDK page revised fields')
    expect(resultJson(await editorClient.client.callTool({ name: 'update_page_fields', arguments: { pageId: page.id, changeSetId: contentSet.id, expectedChangeSetRevision: pageFieldsResult.draft.changeSetRevision, expectedPageHash: '0'.repeat(64), fields: { title: 'stale must not persist' } } }))).toEqual({ error: 'stale_page_edit' })
    const afterStaleFields = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>; expect(pageEditorProjection(afterStaleFields)).toEqual(afterFields)
    const fixedID = '22222222-2222-4222-8222-222222222222'
    const { default: sharp } = await import('sharp'); const fixedAssetBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#155e75' } }).png().toBuffer()
    const fixedAsset = await payload.create({ collection: 'assets', data: { alt: 'Fixed SDK test image' }, file: { data: fixedAssetBytes, mimetype: 'image/png', name: 'fixed-sdk.png', size: fixedAssetBytes.length }, overrideAccess: true })
    await payload.update({ collection: 'pages', id: page.id, data: { blocks: [...afterFields.blocks, { id: fixedID, type: 'media', mediaId: fixedAsset.id, hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    const beforeFixedRecord = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>; const beforeFixed = pageEditorProjection(beforeFixedRecord)
    expect(resultJson(await editorClient.client.callTool({ name: 'hide_block', arguments: { pageId: page.id, changeSetId: contentSet.id, expectedChangeSetRevision: pageFieldsResult.draft.changeSetRevision, expectedPageHash: pageEditorHash(beforeFixed), blockId: fixedID, hidden: true } }))).toEqual({ error: 'fixed_block' })
    const afterFixedRecord = await payload.findByID({ collection: 'pages', id: page.id, draft: true, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>; expect(pageEditorProjection(afterFixedRecord)).toEqual(beforeFixed)
    const recipeSet = resultJson(await editorClient.client.callTool({ name: 'create_change_set', arguments: { name: 'MCP recipe' } })) as { id: string; revision: number }
    const recipeArguments = { changeSetId: recipeSet.id, expectedChangeSetRevision: recipeSet.revision, requestKey: randomUUID(), title: 'Recipe page', summary: 'A synthetic page created from an ordered MCP recipe.', slug: 'recipe-page', sectionId: section.id, template: 'standard', blocks: [{ type: 'callout', appearance: { background: 'accent', width: 'wide', spacing: 'compact', motionIntent: 'subtle', logoTone: 'inverse' } }, { type: 'faq' }] }
    const recipePage = resultJson(await editorClient.client.callTool({ name: 'create_page_from_recipe', arguments: recipeArguments })) as { id: string; blocks: Array<{ id: string; type: string; appearance: Record<string, string> }> }
    expect(recipePage.blocks.map((block) => block.type)).toEqual(['callout', 'faq'])
    expect(recipePage.blocks[0]?.appearance).toMatchObject({ background: 'accent', width: 'wide', spacing: 'compact', motionIntent: 'subtle', logoTone: 'inverse' })
    const recipeReplay = resultJson(await editorClient.client.callTool({ name: 'create_page_from_recipe', arguments: recipeArguments })) as typeof recipePage
    expect(recipeReplay.id).toBe(recipePage.id)
    const sectionSet = resultJson(await editorClient.client.callTool({ name: 'create_change_set', arguments: { name: 'MCP section' } })) as { id: string; revision: number }
    const createdSection = resultJson(await editorClient.client.callTool({ name: 'create_section', arguments: { changeSetId: sectionSet.id, expectedChangeSetRevision: sectionSet.revision, requestKey: randomUUID(), name: 'SDK created section', slug: `sdk-created-${randomUUID().slice(0, 8)}`, allowedTemplates: ['standard'] } })) as { id: string; name: string }
    expect(createdSection).toMatchObject({ name: 'SDK created section' })
    const sectionAfterCreate = await payload.findByID({ collection: 'change-sets', id: sectionSet.id, depth: 0, overrideAccess: true }) as { revision: number }
    expect(resultJson(await editorClient.client.callTool({ name: 'update_section', arguments: { id: createdSection.id, changeSetId: sectionSet.id, expectedChangeSetRevision: sectionAfterCreate.revision, name: 'SDK updated section' } }))).toMatchObject({ id: createdSection.id, name: 'SDK updated section' })
    const sectionAfterUpdate = await payload.findByID({ collection: 'change-sets', id: sectionSet.id, depth: 0, overrideAccess: true }) as { revision: number }
    expect(resultJson(await editorClient.client.callTool({ name: 'update_section', arguments: { id: createdSection.id, changeSetId: sectionSet.id, expectedChangeSetRevision: sectionAfterUpdate.revision - 1, name: 'stale section' } }))).toEqual({ error: 'revision_conflict' })
    expect(recipeReplay.blocks.map((block) => block.id)).toEqual(recipePage.blocks.map((block) => block.id))
    const text = JSON.stringify([sections, found, selected, redirects]); expect(text).not.toContain('private@example.test'); expect(text).not.toContain('never-expose-this-secret')
    expect(resultJson(await ownerClient.client.callTool({ name: 'get_site_settings', arguments: {} }))).toMatchObject({ siteName: 'MCP site', legalName: 'MCP Site Incorporated', defaultLocale: 'en-CA', address: { addressCountry: 'CA' }, linkedIn: 'https://www.linkedin.com/company/mcp-site', incident: { label: 'Incident in progress?' } })
    expect(resultJson(await ownerClient.client.callTool({ name: 'get_block_library', arguments: {} }))).toMatchObject({ blockTypes: expect.arrayContaining(['hero']) })
    expect(resultJson(await ownerClient.client.callTool({ name: 'list_installed_themes', arguments: {} }))).toMatchObject({ themes: expect.any(Array) })
    expect(resultJson(await ownerClient.client.callTool({ name: 'get_page_quality', arguments: { id: frozen.pages[0]!.id } }))).toMatchObject({ source: 'frozen-published-snapshot', pageId: frozen.pages[0]!.id, styleGuide: expect.objectContaining({ bannedPhrases: ['frozen phrase'] }) })
    await payload.update({ collection: 'style-guides', id: mutableGuide.id, data: { bannedPhrases: ['draft-only phrase'] }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    expect(resourceJson(await editorClient.client.readResource({ uri: 'site-engine://contract/style-guide' }))).toMatchObject({ source: 'frozen-published-snapshot', bannedPhrases: ['frozen phrase'] })
    expect(resultJson(await editorClient.client.callTool({ name: 'get_site_settings', arguments: {} }))).toMatchObject({ error: 'owner_access_required' })
    await expect(approverClient.client.callTool({ name: 'list_redirects', arguments: {} })).rejects.toMatchObject({ code: 403 })
    const audit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'mcp.request' } }, overrideAccess: true, limit: 100 })
    expect(audit.docs.some((event) => event.detail && JSON.stringify(event.detail).includes('clientIdHash'))).toBe(true)
    expect(JSON.stringify(audit.docs)).not.toContain('editor-client')
    expect(JSON.stringify(audit.docs)).not.toContain('editor-token')
    await payload.update({ collection: 'users', id: editor.id, data: { roles: ['sales'] }, overrideAccess: true })
    await expect(editorClient.client.callTool({ name: 'list_sections', arguments: {} })).rejects.toMatchObject({ code: 401 })
    await payload.update({ collection: 'users', id: editor.id, data: { roles: ['editor'] }, overrideAccess: true })
    await expect(editorClient.client.callTool({ name: 'list_sections', arguments: {} })).rejects.toMatchObject({ code: 401 })
  } finally { await Promise.all([editorClient.transport.close(), qualityWriterClient.transport.close(), approverClient.transport.close(), ownerClient.transport.close(), ownerPersonalClient.transport.close(), salesClient.transport.close(), hiringClient.transport.close()]) }
}, 15_000)

test('MCP rejects disabled, expired, revoked, wrong-resource and cookie-only credentials, and enforces both rate limits', async () => {
  const user = await payload.create({ collection: 'users', data: { email: 'mcp-disabled@example.test', name: 'MCP Disabled', roles: ['editor'], disabled: true }, overrideAccess: true })
  const disabledSession = await sessionFor(user.id)
  tokens.set('disabled-token', { clientId: 'disabled-client', userId: user.id, sessionId: disabledSession.id, scopes: ['mcp:content:read'] })
  tokens.set('expired-token', { active: false, clientId: 'expired-client', userId: user.id, sessionId: 'expired-session', scopes: [] })
  tokens.set('revoked-token', { active: false, clientId: 'revoked-client', userId: user.id, sessionId: 'revoked-session', scopes: [] })
  tokens.set('wrong-resource-token', { clientId: 'wrong-resource-client', userId: user.id, sessionId: 'wrong-resource-session', scopes: ['mcp:content:read'], resource: `${mcpOrigin}/other` })
  const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
  const post = (headers: HeadersInit = {}, body = rpc) => fetch(`${mcpOrigin}/mcp`, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers }, body })
  expect((await fetch(`${mcpOrigin}/mcp`)).status).toBe(405)
  expect((await post({ cookie: 'site_engine_session=not-a-bearer' })).status).toBe(401)
  for (const token of ['disabled-token', 'expired-token', 'revoked-token', 'wrong-resource-token']) expect((await post({ authorization: `Bearer ${token}` })).status).toBe(401)
  const contentOnly = await payload.create({ collection: 'users', data: { email: 'mcp-content-only@example.test', name: 'MCP Content Only', roles: ['approver'] }, overrideAccess: true })
  const contentOnlySession = await sessionFor(contentOnly.id)
  tokens.set('content-only-token', { clientId: 'content-only-client', userId: contentOnly.id, sessionId: contentOnlySession.id, scopes: ['mcp:content:read'] })
  const noScopeSession = await sessionFor(contentOnly.id)
  tokens.set('no-scope-token', { clientId: 'no-scope-client', userId: contentOnly.id, sessionId: noScopeSession.id, scopes: [] })
  const redirectCall = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_redirects', arguments: {} } })
  const scopeDenied = await post({ authorization: 'Bearer content-only-token', 'x-mcp-required-scope': 'mcp:content:read' }, redirectCall)
  expect(scopeDenied.status).toBe(403)
  expect(scopeDenied.headers.get('www-authenticate')).toContain('error="insufficient_scope", scope="mcp:redirects:read"')
  for (const [id, method, params] of [
    [4, 'resources/list', {}], [5, 'resources/templates/list', {}], [6, 'resources/read', { uri: 'site-engine://contract/glossary' }], [7, 'prompts/list', {}], [8, 'prompts/get', { name: 'plan-page', arguments: { objective: 'Denied' } }],
  ] as const) {
    const deniedRead = await post({ authorization: 'Bearer no-scope-token' }, JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    expect(deniedRead.status).toBe(403)
    expect(deniedRead.headers.get('www-authenticate')).toContain('scope="mcp:content:read"')
  }
  const secretLikeTool = 'do-not-write-this-tool-name-to-audit'
  expect((await post({ authorization: 'Bearer content-only-token' }, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: secretLikeTool, arguments: {} } }))).status).toBe(200)
  const unknownAudit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'mcp.request' } }, overrideAccess: true, sort: '-createdAt', limit: 1 })
  expect(unknownAudit.docs[0]?.detail).toMatchObject({ method: 'tools/call', tool: 'unknown' })
  expect(JSON.stringify(unknownAudit.docs[0])).not.toContain(secretLikeTool)
  tokens.set('bad-id-token', { clientId: 'bad identity value', userId: contentOnly.id, sessionId: contentOnlySession.id, scopes: ['mcp:content:read'] })
  expect((await post({ authorization: 'Bearer bad-id-token' })).status).toBe(401)
  const rateUser = await payload.create({ collection: 'users', data: { email: 'mcp-rate@example.test', name: 'MCP Rate', roles: ['editor'] }, overrideAccess: true })
  const rateSession = await sessionFor(rateUser.id)
  tokens.set('client-rate-token', { clientId: 'same-client', userId: rateUser.id, sessionId: rateSession.id, scopes: ['mcp:content:read'] })
  for (let count = 0; count < 60; count++) expect((await post({ authorization: 'Bearer client-rate-token' })).status).toBe(200)
  expect((await post({ authorization: 'Bearer client-rate-token' })).status).toBe(429)
  tokens.set('user-rate-token', { clientId: 'different-client', userId: rateUser.id, sessionId: rateSession.id, scopes: ['mcp:content:read'] })
  expect((await post({ authorization: 'Bearer user-rate-token' })).status).toBe(429)
}, 15_000)

test('MCP cancels a chunked body over the limit before introspection, Payload, or audit work', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(32_769)); },
    cancel() { cancelled = true },
  })
  const before = await payload.find({ collection: 'audit-events', where: { event: { equals: 'mcp.request' } }, overrideAccess: true, limit: 0 })
  const introspectionsBefore = introspections
  const response = await handleMcp(new Request(`${mcpOrigin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit))
  expect(response.status).toBe(413)
  expect(cancelled).toBe(true)
  expect(introspections).toBe(introspectionsBefore)
  const after = await payload.find({ collection: 'audit-events', where: { event: { equals: 'mcp.request' } }, overrideAccess: true, limit: 0 })
  expect(after.totalDocs).toBe(before.totalDocs)
})

test('MCP returns a retryable HTTP response when its request audit is blocked by an external SQLite writer', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: `mcp-busy-${randomUUID()}@example.test`, name: 'MCP Busy', roles: ['editor'] }, overrideAccess: true })
  const session = await sessionFor(editor.id)
  tokens.set('mcp-busy-token', { clientId: 'mcp-busy-client', userId: editor.id, sessionId: session.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  const external = createClient({ url: `file:${join(directory, 'cms.sqlite')}` })
  const lock = await external.transaction('write')
  try {
    await lock.execute({ sql: 'UPDATE users SET updated_at = updated_at WHERE id = ?', args: [String(editor.id)] })
    const client = new Client({ name: 'mcp-sdk-busy', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`${mcpOrigin}/mcp`), { requestInit: { headers: { authorization: 'Bearer mcp-busy-token' } } })
    const raw = await fetch(`${mcpOrigin}/mcp`, { method: 'POST', headers: { authorization: 'Bearer mcp-busy-token', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'busy', version: '1' } } }) })
    expect(raw.status).toBe(503); expect(raw.headers.get('Retry-After')).toBe('1'); expect(raw.headers.get('Cache-Control')).toBe('no-store'); await expect(raw.json()).resolves.toEqual({ error: 'temporarily_unavailable', retryAfterSeconds: 1 })
    await expect(client.connect(transport)).rejects.toThrow(/temporarily_unavailable/)
  } finally { await lock.rollback(); external.close() }
  const client = await clientFor('mcp-busy-token')
  try { expect((await client.client.listTools()).tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'create_change_set' })])) } finally { await client.client.close() }
}, 15_000)

test('MCP mutation returns a retryable tool error when a writer locks SQLite after its request audit', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: `mcp-mutation-busy-${randomUUID()}@example.test`, name: 'MCP Mutation Busy', roles: ['editor'] }, overrideAccess: true })
  const session = await sessionFor(editor.id)
  tokens.set('mcp-mutation-busy-token', { clientId: 'mcp-mutation-busy-client', userId: editor.id, sessionId: session.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  const sdk = await clientFor('mcp-mutation-busy-token')
  const beforeSets = await payload.count({ collection: 'change-sets', overrideAccess: true })
  const beforeOutbox = await payload.count({ collection: 'publish-outbox', overrideAccess: true })
  const originalCreate = payload.create.bind(payload)
  const external = createClient({ url: `file:${join(directory, 'cms.sqlite')}` })
  let lock: Awaited<ReturnType<typeof external.transaction>> | undefined
  let armed = true
  ;(payload as unknown as { create: typeof payload.create }).create = (async (args: Parameters<typeof payload.create>[0]) => {
    const result = await originalCreate(args)
    if (armed && args.collection === 'audit-events' && (args.data as { event?: unknown }).event === 'mcp.request') {
      armed = false; lock = await external.transaction('write')
      await lock.execute({ sql: 'UPDATE users SET updated_at = updated_at WHERE id = ?', args: [String(editor.id)] })
    }
    return result
  }) as typeof payload.create
  try {
    const response = await sdk.client.callTool({ name: 'create_change_set', arguments: { name: 'Busy mutation' } })
    expect(response).toMatchObject({ isError: true })
    const blocked = resultJson(response)
    expect(blocked).toEqual({ error: 'temporarily_unavailable', retryAfterSeconds: 1 })
    expect((await payload.count({ collection: 'change-sets', overrideAccess: true })).totalDocs).toBe(beforeSets.totalDocs)
    expect((await payload.count({ collection: 'publish-outbox', overrideAccess: true })).totalDocs).toBe(beforeOutbox.totalDocs)
  } finally {
    ;(payload as unknown as { create: typeof payload.create }).create = originalCreate as typeof payload.create
    await lock?.rollback(); external.close()
  }
  expect(resultJson(await sdk.client.callTool({ name: 'create_change_set', arguments: { name: 'Retry mutation' } }))).toMatchObject({ state: 'open', revision: 0 })
  await sdk.transport.close()
}, 15_000)

test('ENG-017 content-write tools require scope and preserve draft review boundaries', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: 'mcp-write@example.test', name: 'MCP Writer', roles: ['editor'] }, overrideAccess: true })
  const session = await sessionFor(editor.id)
  tokens.set('write-read-only', { clientId: 'write-read-only', userId: editor.id, sessionId: session.id, scopes: ['mcp:content:read'] })
  tokens.set('write-editor', { clientId: 'write-editor', userId: editor.id, sessionId: session.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  const readonly = await clientFor('write-read-only'); const writer = await clientFor('write-editor')
  try {
    await expect(readonly.client.callTool({ name: 'create_change_set', arguments: { name: 'Denied' } })).rejects.toMatchObject({ code: 403 })
    const created = resultJson(await writer.client.callTool({ name: 'create_change_set', arguments: { name: 'MCP draft' } })) as { id: string; revision: number; state: string }
    expect(created).toMatchObject({ state: 'open', revision: 0 })
    expect(resultJson(await writer.client.callTool({ name: 'get_change_set', arguments: { id: created.id } }))).toMatchObject({ id: created.id, state: 'open' })
    expect(resultJson(await writer.client.callTool({ name: 'submit_change_set', arguments: { id: created.id, expectedRevision: 1 } }))).toMatchObject({ error: 'write_failed' })
    await withPayloadTransaction(payload, async (req) => { req.user = editor as never; req.headers.set('x-site-engine-change-set', created.id); const section = await payload.create({ collection: 'sections', data: { name: 'MCP write', summary: 'Synthetic section for a valid MCP change set submission test.', slug: `mcp-write-${created.id.slice(0, 8)}`, allowedTemplates: ['standard'] }, user: editor, overrideAccess: false, req }); await payload.create({ collection: 'pages', data: { title: 'MCP draft page', summary: 'Synthetic page captured in the explicit MCP change set for submission.', slug: 'mcp-draft-page', sectionId: section.id, template: 'standard' }, user: editor, overrideAccess: false, req }) })
    const changed = await payload.findByID({ collection: 'change-sets', id: created.id, overrideAccess: true })
    expect(resultJson(await writer.client.callTool({ name: 'submit_change_set', arguments: { id: created.id, expectedRevision: changed.revision } }))).toMatchObject({ state: 'submitted' })
    await payload.update({ collection: 'auth-sessions', id: session.id, data: { revokedAt: new Date().toISOString() }, overrideAccess: true })
    await expect(writer.client.callTool({ name: 'get_change_set', arguments: { id: created.id } })).rejects.toMatchObject({ code: 401 })
  } finally { await Promise.all([readonly.transport.close(), writer.transport.close()]) }
})

test('ENG-032 structural tools capture caller-owned drafts, validate trees, and retain the published snapshot', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: `mcp-structure-${randomUUID()}@example.test`, name: 'MCP Structure Editor', roles: ['editor'] }, overrideAccess: true })
  const reader = await payload.create({ collection: 'users', data: { email: `mcp-structure-reader-${randomUUID()}@example.test`, name: 'MCP Structure Reader', roles: ['editor'] }, overrideAccess: true })
  const [editorSession, readerSession] = await Promise.all([sessionFor(editor.id), sessionFor(reader.id)])
  tokens.set('mcp-structure-editor', { clientId: 'mcp-structure-editor-client', userId: editor.id, sessionId: editorSession.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  tokens.set('mcp-structure-reader', { clientId: 'mcp-structure-reader-client', userId: reader.id, sessionId: readerSession.id, scopes: ['mcp:content:read'] })
  const [writer, readonly] = await Promise.all([clientFor('mcp-structure-editor'), clientFor('mcp-structure-reader')])
  try {
    const readPage = async (id: string) => resultJson(await writer.client.callTool({ name: 'get_page', arguments: { id } })) as { id: string; pageHash: string; structuralHash: string; parentId: string | null; sectionId: string; template: string }
    const readSection = async (id: string) => (resultJson(await writer.client.callTool({ name: 'list_sections', arguments: {} })) as Array<{ id: string; sectionHash: string; pageIds: string[] }>).find(section => section.id === id)!
    const publishedHash = async () => {
      const release = (await payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 0, overrideAccess: true })).docs[0]!
      const snapshotID = typeof release.snapshot === 'string' ? release.snapshot : release.snapshot.id
      return (await payload.findByID({ collection: 'publish-snapshots', id: snapshotID, depth: 0, overrideAccess: true })).contentHash
    }
    const tools = await writer.client.listTools()
    expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['archive_section', 'duplicate_page', 'move_page', 'change_page_template', 'archive_page']))
    await expect(readonly.client.callTool({ name: 'duplicate_page', arguments: { pageId: randomUUID(), changeSetId: randomUUID(), expectedChangeSetRevision: 0, expectedStructuralHash: 'a'.repeat(64), title: 'Denied copy', slug: 'denied-copy', requestKey: randomUUID() } })).rejects.toMatchObject({ code: 403 })

    const sourceSection = await payload.create({ collection: 'sections', data: { name: 'Structural source', summary: 'A synthetic section for real SDK structural mutations.', slug: `structural-source-${randomUUID().slice(0, 8)}`, allowedTemplates: ['standard', 'article'] }, user: editor, overrideAccess: false })
    const destinationSection = await payload.create({ collection: 'sections', data: { name: 'Structural destination', summary: 'A synthetic destination section for SDK page moves.', slug: `structural-destination-${randomUUID().slice(0, 8)}`, allowedTemplates: ['standard', 'article'] }, user: editor, overrideAccess: false })
    const source = await payload.create({ collection: 'pages', data: { title: 'Structural source page', summary: 'A synthetic source page used to prove structural MCP operations keep review captures.', slug: `structural-source-${randomUUID().slice(0, 8)}`, sectionId: sourceSection.id, template: 'standard', blocks: [{ id: randomUUID(), type: 'hero', heading: 'Structural source', body: 'This source has a valid standard hero block.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, user: editor, overrideAccess: false }) as unknown as Record<string, unknown>
    const sourceRead = await readPage(String(source.id))
    expect(sourceRead).toMatchObject({ id: source.id, sectionId: sourceSection.id, parentId: null, template: 'standard', pageHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const sourceHash = sourceRead.structuralHash
    const set = resultJson(await writer.client.callTool({ name: 'create_change_set', arguments: { name: 'Structural SDK mutation' } })) as { id: string; revision: number }
    const copied = resultJson(await writer.client.callTool({ name: 'duplicate_page', arguments: { pageId: source.id, changeSetId: set.id, expectedChangeSetRevision: set.revision, expectedStructuralHash: sourceHash, title: 'Structural copy', slug: `structural-copy-${randomUUID().slice(0, 8)}`, requestKey: randomUUID() } })) as { id: string; sectionId: string; blocks: Array<{ id: string }> }
    expect(copied).toMatchObject({ sectionId: sourceSection.id })
    expect(copied.blocks[0]?.id).not.toBe((source.blocks as Array<{ id: string }>)[0]?.id)
    expect(resultJson(await writer.client.callTool({ name: 'duplicate_page', arguments: { pageId: source.id, changeSetId: set.id, expectedChangeSetRevision: set.revision, expectedStructuralHash: sourceHash, title: 'Structural copy', slug: `replayed-copy-${randomUUID().slice(0, 8)}`, requestKey: randomUUID() } }))).toEqual({ error: 'revision_conflict' })
    expect((await payload.find({ collection: 'pages', where: { sectionId: { equals: sourceSection.id } }, limit: 0, overrideAccess: true })).docs.filter(page => page.title === 'Structural copy')).toHaveLength(1)
    const afterCopy = await payload.findByID({ collection: 'change-sets', id: set.id, depth: 0, overrideAccess: true }) as unknown as { revision: number; changes: Array<{ collection: string; id: string }> }
    const copyHash = (await readPage(copied.id)).structuralHash
    expect(resultJson(await writer.client.callTool({ name: 'move_page', arguments: { pageId: copied.id, changeSetId: set.id, expectedChangeSetRevision: afterCopy.revision, expectedStructuralHash: copyHash, sectionId: destinationSection.id, parentId: null } }))).toMatchObject({ id: copied.id, sectionId: destinationSection.id })
    const afterMove = await payload.findByID({ collection: 'change-sets', id: set.id, depth: 0, overrideAccess: true }) as unknown as { revision: number }
    const movedHash = (await readPage(copied.id)).structuralHash
    expect(resultJson(await writer.client.callTool({ name: 'move_page', arguments: { pageId: copied.id, changeSetId: set.id, expectedChangeSetRevision: afterMove.revision, expectedStructuralHash: copyHash, sectionId: sourceSection.id, parentId: null } }))).toEqual({ error: 'stale_page_edit' })
    expect((await payload.findByID({ collection: 'pages', id: copied.id, depth: 0, draft: true, overrideAccess: true }) as { sectionId: string }).sectionId).toBe(destinationSection.id)
    expect(resultJson(await writer.client.callTool({ name: 'change_page_template', arguments: { pageId: copied.id, changeSetId: set.id, expectedChangeSetRevision: afterMove.revision, expectedStructuralHash: movedHash, template: 'article' } }))).toEqual({ error: 'write_failed' })
    expect((await payload.findByID({ collection: 'pages', id: copied.id, depth: 0, draft: true, overrideAccess: true }) as { template: string }).template).toBe('standard')

    const templatePage = await payload.create({ collection: 'pages', data: { title: 'Convertible structural page', summary: 'A block-free page that can validly change its template through the SDK.', slug: `convertible-${randomUUID().slice(0, 8)}`, sectionId: destinationSection.id, template: 'standard', blocks: [] }, user: editor, overrideAccess: false })
    const revisionBeforeTemplate = (await payload.findByID({ collection: 'change-sets', id: set.id, depth: 0, overrideAccess: true })).revision
    expect(resultJson(await writer.client.callTool({ name: 'change_page_template', arguments: { pageId: templatePage.id, changeSetId: set.id, expectedChangeSetRevision: revisionBeforeTemplate, expectedStructuralHash: (await readPage(templatePage.id)).structuralHash, template: 'article' } }))).toMatchObject({ id: templatePage.id, template: 'article' })
    expect((await payload.findByID({ collection: 'pages', id: templatePage.id, depth: 0, draft: true, overrideAccess: true })).template).toBe('article')

    const manifest = structuredClone(neutralFixture)
    const homeSection = { ...manifest.settings.sections[0]! }
    const homePage = { ...manifest.pages[0]! }
    manifest.settings.sections = [homeSection, { ...homeSection, id: String(sourceSection.id), slug: String(sourceSection.slug), pageIds: [String(source.id)], landingPageId: undefined, allowedTemplates: ['standard', 'article'] }]
    manifest.pages = [homePage, { ...homePage, id: String(source.id), sectionId: String(sourceSection.id), slug: String(source.slug), title: String(source.title), summary: String(source.summary), template: 'standard', blocks: source.blocks as never }]
    await publishFrozenSnapshot(editor.id, manifest)
    const frozenHash = await publishedHash()
    const archiveSet = resultJson(await writer.client.callTool({ name: 'create_change_set', arguments: { name: 'Archive source page' } })) as { id: string; revision: number }
    await payload.create({ collection: 'redirects', data: { from: '/redirect-target', to: '/' }, overrideAccess: true, context: { editorialInternal: true } })
    expect(resultJson(await writer.client.callTool({ name: 'archive_page', arguments: { pageId: source.id, changeSetId: archiveSet.id, expectedChangeSetRevision: archiveSet.revision, expectedStructuralHash: sourceHash, redirectTo: '/redirect-target' } }))).toEqual({ error: 'write_failed' })
    expect((await payload.findByID({ collection: 'pages', id: String(source.id), depth: 0, draft: true, overrideAccess: true }) as { status: string }).status).toBe('draft')
    expect(resultJson(await writer.client.callTool({ name: 'archive_page', arguments: { pageId: source.id, changeSetId: archiveSet.id, expectedChangeSetRevision: archiveSet.revision, expectedStructuralHash: sourceHash, redirectTo: '/' } }))).toMatchObject({ pageId: source.id, archived: true, redirect: { to: '/' } })
    expect((await payload.findByID({ collection: 'pages', id: String(source.id), depth: 0, draft: true, overrideAccess: true }) as { status: string }).status).toBe('archived')
    expect(await publishedHash()).toBe(frozenHash)

    const safetySection = await payload.create({ collection: 'sections', data: { name: 'Archive safety section', summary: 'A section used to prove archive hashes reject unlisted pages and navigation order changes.', slug: `archive-safety-${randomUUID().slice(0, 8)}`, allowedTemplates: ['standard'] }, user: editor, overrideAccess: false })
    const safetyPage = async (title: string) => payload.create({ collection: 'pages', data: { title, summary: 'A synthetic draft page used to verify archive-section optimistic concurrency.', slug: `${title.toLowerCase().replaceAll(' ', '-')}-${randomUUID().slice(0, 8)}`, sectionId: safetySection.id, template: 'standard' }, overrideAccess: true, context: { editorialInternal: true } })
    const [safetyFirst, safetySecond] = await Promise.all([safetyPage('Archive safety first'), safetyPage('Archive safety second')])
    await payload.update({ collection: 'sections', id: safetySection.id, data: { pageIds: [String(safetyFirst.id), String(safetySecond.id)] }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    const safetySet = resultJson(await writer.client.callTool({ name: 'create_change_set', arguments: { name: 'Reject concurrent section changes' } })) as { id: string; revision: number }
    const beforeUnlisted = (await readSection(safetySection.id)).sectionHash
    const unlisted = await safetyPage('Archive safety unlisted')
    expect(resultJson(await writer.client.callTool({ name: 'archive_section', arguments: { sectionId: safetySection.id, changeSetId: safetySet.id, expectedChangeSetRevision: safetySet.revision, expectedSectionHash: beforeUnlisted, redirectTo: '/' } }))).toEqual({ error: 'stale_section_edit' })
    const beforeNavigationOrder = (await readSection(safetySection.id)).sectionHash
    await payload.update({ collection: 'sections', id: safetySection.id, data: { pageIds: [String(safetySecond.id), String(safetyFirst.id)] }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    expect(resultJson(await writer.client.callTool({ name: 'archive_section', arguments: { sectionId: safetySection.id, changeSetId: safetySet.id, expectedChangeSetRevision: safetySet.revision, expectedSectionHash: beforeNavigationOrder, redirectTo: '/' } }))).toEqual({ error: 'stale_section_edit' })
    expect((await payload.find({ collection: 'pages', where: { sectionId: { equals: safetySection.id } }, limit: 0, draft: true, overrideAccess: true })).docs.map(page => page.status)).toEqual(['draft', 'draft', 'draft'])
    expect((await payload.findByID({ collection: 'sections', id: safetySection.id, depth: 0, draft: true, overrideAccess: true }) as { pageIds: string[] }).pageIds).toEqual([safetySecond.id, safetyFirst.id])
    expect(unlisted.id).toBeDefined()

    const retiringSection = await payload.create({ collection: 'sections', data: { name: 'Retiring section', summary: 'A section archived by the real MCP SDK structural test.', slug: `retiring-section-${randomUUID().slice(0, 8)}`, allowedTemplates: ['standard'] }, user: editor, overrideAccess: false })
    const retiringPage = await payload.create({ collection: 'pages', data: { title: 'Retiring section page', summary: 'A synthetic page that proves a section archive captures redirects and draft state.', slug: `retiring-page-${randomUUID().slice(0, 8)}`, sectionId: retiringSection.id, template: 'standard', blocks: [{ id: randomUUID(), type: 'hero', heading: 'Retiring', body: 'This page is archived through the section operation.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, user: editor, overrideAccess: false }) as unknown as Record<string, unknown>
    await payload.update({ collection: 'sections', id: retiringSection.id, data: { pageIds: [String(retiringPage.id)] }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    const retiringManifest = structuredClone(neutralFixture)
    const retiringHomeSection = { ...retiringManifest.settings.sections[0]! }
    const retiringHomePage = { ...retiringManifest.pages[0]! }
    retiringManifest.settings.sections = [retiringHomeSection, { ...retiringHomeSection, id: String(retiringSection.id), slug: String(retiringSection.slug), pageIds: [String(retiringPage.id)], landingPageId: undefined, allowedTemplates: ['standard'] }]
    retiringManifest.pages = [retiringHomePage, { ...retiringHomePage, id: String(retiringPage.id), sectionId: String(retiringSection.id), slug: String(retiringPage.slug), title: String(retiringPage.title), summary: String(retiringPage.summary), template: 'standard', blocks: retiringPage.blocks as never }]
    await publishFrozenSnapshot(editor.id, retiringManifest)
    const retiringPublishedHash = await publishedHash()
    const sectionSet = resultJson(await writer.client.callTool({ name: 'create_change_set', arguments: { name: 'Archive structural section' } })) as { id: string; revision: number }
    const staleSectionHash = (await readSection(retiringSection.id)).sectionHash
    await payload.update({ collection: 'sections', id: retiringSection.id, data: { summary: 'Concurrent section metadata change.' }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    expect(resultJson(await writer.client.callTool({ name: 'archive_section', arguments: { sectionId: retiringSection.id, changeSetId: sectionSet.id, expectedChangeSetRevision: sectionSet.revision, expectedSectionHash: staleSectionHash, redirectTo: '/' } }))).toEqual({ error: 'stale_section_edit' })
    expect((await payload.findByID({ collection: 'pages', id: String(retiringPage.id), depth: 0, draft: true, overrideAccess: true }) as { status: string }).status).toBe('draft')
    expect(resultJson(await writer.client.callTool({ name: 'archive_section', arguments: { sectionId: retiringSection.id, changeSetId: sectionSet.id, expectedChangeSetRevision: sectionSet.revision, expectedSectionHash: (await readSection(retiringSection.id)).sectionHash, redirectTo: '/' } }))).toMatchObject({ archived: true, pageIds: [retiringPage.id], redirects: [{ to: '/' }], section: { pageIds: [], landingPageId: null } })
    expect((await payload.findByID({ collection: 'pages', id: String(retiringPage.id), depth: 0, draft: true, overrideAccess: true }) as { status: string }).status).toBe('archived')
    expect(await payload.findByID({ collection: 'sections', id: retiringSection.id, depth: 0, draft: true, overrideAccess: true })).toMatchObject({ pageIds: [] })
    expect(await publishedHash()).toBe(retiringPublishedHash)

    const mixedSection = await payload.create({ collection: 'sections', data: { name: 'Mixed archive section', summary: 'A section containing an existing archived page and active parent and child pages.', slug: `mixed-section-${randomUUID().slice(0, 8)}`, allowedTemplates: ['standard'] }, overrideAccess: true, context: { editorialInternal: true } })
    const mixedParent = await payload.create({ collection: 'pages', data: { title: 'Mixed active parent', summary: 'A synthetic active parent page for mixed archive section coverage.', slug: `mixed-parent-${randomUUID().slice(0, 8)}`, sectionId: mixedSection.id, template: 'standard', blocks: [] }, overrideAccess: true, context: { editorialInternal: true } })
    const mixedChild = await payload.create({ collection: 'pages', data: { title: 'Mixed active child', summary: 'A synthetic active child page for mixed archive section coverage.', slug: `mixed-child-${randomUUID().slice(0, 8)}`, sectionId: mixedSection.id, parentId: mixedParent.id, template: 'standard', blocks: [] }, overrideAccess: true, context: { editorialInternal: true } })
    const alreadyArchived = await payload.create({ collection: 'pages', data: { title: 'Previously archived', summary: 'A synthetic archived page that must not be archived or redirected a second time.', slug: `previously-archived-${randomUUID().slice(0, 8)}`, sectionId: mixedSection.id, template: 'standard', blocks: [] }, overrideAccess: true, context: { editorialInternal: true } })
    await payload.update({ collection: 'pages', id: alreadyArchived.id, data: { status: 'archived' }, draft: true, overrideAccess: true, context: { archiveInternal: true, editorialInternal: true } })
    await payload.update({ collection: 'sections', id: mixedSection.id, data: { pageIds: [mixedParent.id, mixedChild.id] }, draft: true, overrideAccess: true, context: { editorialInternal: true } })
    await payload.create({ collection: 'redirects', data: { from: '/previously-archived', to: '/legacy' }, overrideAccess: true, context: { editorialInternal: true } })
    const mixedManifest = structuredClone(neutralFixture)
    const mixedHomeSection = { ...mixedManifest.settings.sections[0]! }
    const mixedHomePage = { ...mixedManifest.pages[0]! }
    mixedManifest.settings.sections = [mixedHomeSection, { ...mixedHomeSection, id: String(mixedSection.id), slug: String(mixedSection.slug), pageIds: [String(mixedParent.id), String(mixedChild.id)], landingPageId: undefined, allowedTemplates: ['standard'] }]
    mixedManifest.pages = [
      mixedHomePage,
      { ...mixedHomePage, id: String(mixedParent.id), sectionId: String(mixedSection.id), slug: String(mixedParent.slug), title: String(mixedParent.title), summary: String(mixedParent.summary), template: 'standard', blocks: [] },
      { ...mixedManifest.pages[0]!, id: String(mixedChild.id), sectionId: String(mixedSection.id), parentId: String(mixedParent.id), slug: String(mixedChild.slug), title: String(mixedChild.title), summary: String(mixedChild.summary), template: 'standard', blocks: [] },
    ]
    await publishFrozenSnapshot(editor.id, mixedManifest)
    const mixedPublishedHash = await publishedHash()
    const mixedSet = resultJson(await writer.client.callTool({ name: 'create_change_set', arguments: { name: 'Archive mixed structural section' } })) as { id: string; revision: number }
    expect(resultJson(await writer.client.callTool({ name: 'archive_section', arguments: { sectionId: mixedSection.id, changeSetId: mixedSet.id, expectedChangeSetRevision: mixedSet.revision, expectedSectionHash: (await readSection(mixedSection.id)).sectionHash, redirectTo: '/' } }))).toMatchObject({ archived: true, pageIds: [mixedChild.id, mixedParent.id], redirects: [{ to: '/' }, { to: '/' }] })
    expect((await payload.findByID({ collection: 'pages', id: alreadyArchived.id, depth: 0, draft: true, overrideAccess: true }) as { status: string }).status).toBe('archived')
    expect((await payload.find({ collection: 'redirects', where: { from: { equals: '/previously-archived' } }, limit: 1, depth: 0, overrideAccess: true })).docs[0]).toMatchObject({ to: '/legacy' })
    expect(await publishedHash()).toBe(mixedPublishedHash)
  } finally { await Promise.all([writer.transport.close(), readonly.transport.close()]) }
})

test('MCP canonical review tools enforce ownership, revisions, and review-only boundaries', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: `mcp-review-editor-${randomUUID()}@example.test`, name: 'MCP Review Editor', roles: ['editor'] }, overrideAccess: true })
  const other = await payload.create({ collection: 'users', data: { email: `mcp-review-other-${randomUUID()}@example.test`, name: 'MCP Review Other', roles: ['editor'] }, overrideAccess: true })
  const [editorSession, otherSession] = await Promise.all([sessionFor(editor.id), sessionFor(other.id)])
  tokens.set('mcp-review-editor', { clientId: 'mcp-review-editor-client', userId: editor.id, sessionId: editorSession.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  tokens.set('mcp-review-other', { clientId: 'mcp-review-other-client', userId: other.id, sessionId: otherSession.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  const [writer, stranger] = await Promise.all([clientFor('mcp-review-editor'), clientFor('mcp-review-other')])
  try {
    const tools = await writer.client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['start_change_set', 'submit_for_review', 'get_review_status', 'list_change_sets', 'discard_change_set']))
    expect(tools.tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(['approve_change_set', 'publish']))
    const started = resultJson(await writer.client.callTool({ name: 'start_change_set', arguments: { name: 'SDK canonical review' } })) as { id: string; revision: number; checks: Array<{ name: string }> }
    expect(started).toMatchObject({ revision: 0, checks: [] })
    const status = resultJson(await writer.client.callTool({ name: 'get_review_status', arguments: { id: started.id } })) as { id: string; checks: Array<{ name: string }>; comments: unknown[]; privatePreviewURL: string | null }
    expect(status).toMatchObject({ id: started.id, checks: [expect.objectContaining({ name: 'contract-and-tree', status: 'passed', errors: [] })], comments: [], privatePreviewURL: null })
    expect(resultJson(await writer.client.callTool({ name: 'list_change_sets', arguments: {} }))).toMatchObject({ items: [expect.objectContaining({ id: started.id })] })
    const missingSectionID = randomUUID(); const retainedPageID = randomUUID()
    const missingSectionChange = [{ collection: 'pages', id: retainedPageID, before: null, after: { sectionId: missingSectionID }, beforeHash: null, afterHash: null }]
    const retainedDiagnostic = { collection: 'pages', id: retainedPageID, message: 'sectionId: Select an existing content section.' }
    const discarded = await payload.create({ collection: 'change-sets', data: { name: 'Retained discarded history', actor: editor.id, state: 'discarded', revision: 1, changes: missingSectionChange, quality: { checks: [{ name: 'contract-and-tree', status: 'failed', errors: [retainedDiagnostic] }] } }, overrideAccess: true, context: { editorialInternal: true } })
    expect(resultJson(await writer.client.callTool({ name: 'get_review_status', arguments: { id: discarded.id } }))).toMatchObject({ id: discarded.id, state: 'discarded', checks: [{ name: 'contract-and-tree', status: 'failed', errors: [retainedDiagnostic] }] })
    expect((resultJson(await writer.client.callTool({ name: 'list_change_sets', arguments: {} })) as { items: unknown[] }).items).toEqual(expect.arrayContaining([expect.objectContaining({ id: discarded.id, checks: [expect.objectContaining({ errors: [retainedDiagnostic] })] })]))
    const editable = resultJson(await writer.client.callTool({ name: 'start_change_set', arguments: { name: 'Editable missing section' } })) as { id: string }
    await payload.update({ collection: 'change-sets', id: editable.id, data: { changes: missingSectionChange }, overrideAccess: true, context: { editorialInternal: true } })
    expect(resultJson(await writer.client.callTool({ name: 'get_review_status', arguments: { id: editable.id } }))).toMatchObject({ id: editable.id, state: 'open', checks: [expect.objectContaining({ name: 'contract-and-tree', status: 'failed', errors: expect.arrayContaining([retainedDiagnostic]) })] })
    expect(resultJson(await stranger.client.callTool({ name: 'get_review_status', arguments: { id: started.id } }))).toEqual({ error: 'not_found' })
    expect(resultJson(await writer.client.callTool({ name: 'discard_change_set', arguments: { id: started.id, expectedRevision: 1 } }))).toEqual({ error: 'revision_conflict' })
    expect(resultJson(await writer.client.callTool({ name: 'submit_for_review', arguments: { id: started.id, expectedRevision: started.revision } }))).toEqual({ error: 'write_failed' })
    expect(resultJson(await writer.client.callTool({ name: 'discard_change_set', arguments: { id: started.id, expectedRevision: started.revision } }))).toMatchObject({ state: 'discarded', revision: 1 })

    const section = await payload.create({ collection: 'sections', data: { name: 'Review SDK section', summary: 'A section for the canonical review SDK test.', slug: `review-sdk-${randomUUID().slice(0, 8)}`, allowedTemplates: ['standard'] }, user: editor, overrideAccess: false })
    const page = await payload.create({ collection: 'pages', data: { title: 'Current review SDK page', summary: 'A page whose captured change can be submitted through the canonical review tool.', slug: `review-sdk-${randomUUID().slice(0, 8)}`, sectionId: section.id, template: 'standard', blocks: [{ id: randomUUID(), type: 'hero', heading: 'Review SDK heading', body: 'A valid page body for review tool coverage.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, user: editor, overrideAccess: false }) as unknown as Record<string, unknown>
    const after = capturedSnapshot('pages', page)!; const before = { ...after, title: 'Previous review SDK page' }
    const changes = [{ collection: 'pages' as const, id: String(page.id), before, after, beforeHash: canonicalHash(before), afterHash: canonicalHash(after) }]
    const reviewSet = resultJson(await writer.client.callTool({ name: 'start_change_set', arguments: { name: 'SDK review with a captured change' } })) as { id: string; revision: number }
    await payload.update({ collection: 'change-sets', id: reviewSet.id, data: { changes }, overrideAccess: true, context: { editorialInternal: true } })
    const submitted = resultJson(await writer.client.callTool({ name: 'submit_for_review', arguments: { id: reviewSet.id, expectedRevision: reviewSet.revision } })) as { id: string; state: string; revision: number; privatePreviewURL: string | null }
    expect(submitted).toMatchObject({ id: reviewSet.id, state: 'submitted', revision: 1, privatePreviewURL: null })

    const manifest = structuredClone(neutralFixture)
    manifest.settings.homepageId = String(page.id); manifest.settings.sections[0]!.id = String(section.id); manifest.settings.sections[0]!.pageIds = [String(page.id)]
    manifest.pages[0]!.id = String(page.id); manifest.pages[0]!.sectionId = String(section.id); manifest.pages[0]!.slug = String(page.slug); manifest.pages[0]!.title = String(after.title)
    const includedChangeKeys = [`pages:${page.id}`]; const changeHash = changeSetHash(changes); const digest = 'b'.repeat(64)
    const job = await payload.create({ collection: 'preview-render-jobs', data: { changeSet: reviewSet.id, reviewRevision: submitted.revision, changeHash, includedChangeKeys, baselineSequence: 0, liveSequence: 0, liveManifest: manifest, proposedManifest: manifest, liveManifestHash: canonicalHash(manifest), proposedManifestHash: canonicalHash(manifest), versionPins: { themeVersion: 'test', engineVersion: 'test', contractVersion: manifest.settings.contractVersion }, status: 'completed', attempts: 1, artifactDigest: digest }, overrideAccess: true, context: { editorialInternal: true } })
    await payload.update({ collection: 'change-sets', id: reviewSet.id, data: { preview: { status: 'ready', jobID: job.id, revision: submitted.revision, changeHash, includedChangeKeys, baselineSequence: 0, liveManifestHash: canonicalHash(manifest), proposedManifestHash: canonicalHash(manifest) }, reviewComments: [{ id: 'review-comment', author: other.id, body: 'Please check the review preview.', createdAt: '2026-01-01T00:00:00.000Z' }, { unexpected: true }] }, overrideAccess: true, context: { editorialInternal: true } })
    const ready = resultJson(await writer.client.callTool({ name: 'get_review_status', arguments: { id: reviewSet.id } })) as { comments: Array<{ id: string; author: string; body: string; createdAt: string }>; privatePreviewURL: string | null }
    expect(ready.comments).toEqual([{ id: 'review-comment', author: other.id, body: 'Please check the review preview.', createdAt: '2026-01-01T00:00:00.000Z' }])
    expect(ready.privatePreviewURL).toBe(`${mcpOrigin}/review/${reviewSet.id}`)
    await payload.update({ collection: 'change-sets', id: reviewSet.id, data: { revision: submitted.revision + 1 }, overrideAccess: true, context: { editorialInternal: true } })
    expect(resultJson(await writer.client.callTool({ name: 'get_review_status', arguments: { id: reviewSet.id } }))).toMatchObject({ privatePreviewURL: null })
  } finally { await Promise.all([writer.transport.close(), stranger.transport.close()]) }
})

test('MCP change log and rollback require a fresh canonical Owner session', async () => {
  await payload.update({ collection: 'change-sets', where: { state: { in: ['open', 'submitted', 'changes-requested', 'approved'] } }, data: { state: 'discarded' }, overrideAccess: true, context: { editorialInternal: true } })
  const originalSiteSettings = (await payload.find({ collection: 'site-settings', limit: 1, depth: 0, draft: true, overrideAccess: true })).docs[0] as unknown as Record<string, unknown> | undefined
  const owner = await payload.create({ collection: 'users', data: { email: `mcp-rollback-owner-${randomUUID()}@example.test`, name: 'MCP Rollback Owner', roles: ['owner'] }, overrideAccess: true })
  const editor = await payload.create({ collection: 'users', data: { email: `mcp-rollback-editor-${randomUUID()}@example.test`, name: 'MCP Rollback Editor', roles: ['editor'] }, overrideAccess: true })
  const ownerSession = await sessionFor(owner.id); const editorSession = await sessionFor(editor.id)
  const stale = await payload.create({ collection: 'auth-sessions', data: { tokenHash: `mcp-stale-${randomUUID()}`, user: owner.id, authenticatedAt: new Date(Date.now() - 16 * 60_000).toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  const revoked = await sessionFor(owner.id)
  tokens.set('rollback-owner', { clientId: 'rollback-owner-client', userId: owner.id, sessionId: ownerSession.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  tokens.set('rollback-owner-read', { clientId: 'rollback-owner-read-client', userId: owner.id, sessionId: ownerSession.id, scopes: ['mcp:content:read'] })
  tokens.set('rollback-editor', { clientId: 'rollback-editor-client', userId: editor.id, sessionId: editorSession.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  tokens.set('rollback-stale', { clientId: 'rollback-stale-client', userId: owner.id, sessionId: stale.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  tokens.set('rollback-revoked', { clientId: 'rollback-revoked-client', userId: owner.id, sessionId: revoked.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  tokens.set('rollback-wrong-session', { clientId: 'rollback-wrong-client', userId: owner.id, sessionId: editorSession.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  const sequence = (await payload.find({ collection: 'published-releases', limit: 0, overrideAccess: true })).totalDocs + 10
  const previous = structuredClone(neutralFixture); const rollbackSectionID = randomUUID(); const rollbackPageID = randomUUID(); previous.settings.homepageId = rollbackPageID; previous.settings.sections[0]!.id = rollbackSectionID; previous.settings.sections[0]!.pageIds = [rollbackPageID]; previous.pages[0]!.id = rollbackPageID; previous.pages[0]!.sectionId = rollbackSectionID; const current = structuredClone(previous); current.pages[0]!.summary = 'Rollback target current summary'
  const release = async (manifest: typeof neutralFixture, value: string, releaseSequence: number) => {
    const before = { ...manifest.pages[0]!, summary: value === 'current' ? previous.pages[0]!.summary : manifest.pages[0]!.summary }
    const changes = [{ collection: 'pages', id: manifest.pages[0]!.id, before, after: manifest.pages[0]!, beforeHash: canonicalHash(before), afterHash: canonicalHash(manifest.pages[0]!) }]
    const set = await payload.create({ collection: 'change-sets', data: { name: `MCP rollback ${value}`, actor: owner.id, state: 'published', revision: 1, changes }, overrideAccess: true, context: { editorialInternal: true } })
    const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: canonicalHash(manifest), changeSet: set.id, reviewRevision: 1, changeHash: changeSetHash(changes), manifest, themeVersion: 'test', engineVersion: 'test', contractVersion: manifest.settings.contractVersion, approvedBy: owner.id, baselineSequence: releaseSequence - 1 }, overrideAccess: true, context: { editorialInternal: true } })
    const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: randomUUID(), sequence: releaseSequence, snapshot: snapshot.id, changeSet: set.id, reviewRevision: 1, changeHash: changeSetHash(changes), includedChangeKeys: [`pages:${manifest.pages[0]!.id}`], status: 'completed', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
    const published = await payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence: releaseSequence, snapshot: snapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { checks: [] }, artifact: { digest: 'c'.repeat(64), sourceContentHash: snapshot.contentHash, themeVersion: 'test', engineVersion: 'test', contractVersion: manifest.settings.contractVersion, checks: [] } }, overrideAccess: true, context: { editorialInternal: true } })
    await payload.create({ collection: 'audit-events', data: { event: 'editorial.change_set_approved', actor: owner.id, detail: { changeSet: set.id } }, overrideAccess: true })
    return published
  }
  const oldRelease = await release(previous, 'previous', sequence); const currentRelease = await release(current, 'current', sequence + 1); let preparedID: string | undefined
  const [ownerClient, ownerReadClient, editorClient, staleClient, revokedClient] = await Promise.all([clientFor('rollback-owner'), clientFor('rollback-owner-read'), clientFor('rollback-editor'), clientFor('rollback-stale'), clientFor('rollback-revoked')])
  try {
    expect((await ownerClient.client.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['list_changes', 'request_rollback']))
    expect(resultJson(await ownerClient.client.callTool({ name: 'list_changes', arguments: { limit: 100 } }))).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ diff: expect.objectContaining({ entries: expect.arrayContaining([expect.objectContaining({ before: expect.any(String), after: expect.any(String) })]) }), rollback: expect.objectContaining({ releaseID: currentRelease.id, enabled: true }) })]) })
    await expect(ownerReadClient.client.callTool({ name: 'request_rollback', arguments: { releaseID: currentRelease.id } })).rejects.toMatchObject({ code: 403 })
    expect(resultJson(await editorClient.client.callTool({ name: 'request_rollback', arguments: { releaseID: currentRelease.id } }))).toEqual({ error: 'owner_access_required' })
    expect(resultJson(await staleClient.client.callTool({ name: 'request_rollback', arguments: { releaseID: currentRelease.id } }))).toEqual({ error: 'fresh_authentication_required' })
    await payload.update({ collection: 'auth-sessions', id: revoked.id, data: { revokedAt: new Date().toISOString() }, overrideAccess: true })
    await expect(revokedClient.client.callTool({ name: 'request_rollback', arguments: { releaseID: currentRelease.id } })).rejects.toMatchObject({ code: 401 })
    await expect(clientFor('rollback-wrong-session')).rejects.toThrow(/HTTP error/i)
    expect(resultJson(await ownerClient.client.callTool({ name: 'request_rollback', arguments: { releaseID: oldRelease.id } }))).toEqual({ error: 'rollback_unavailable' })
    const prepared = resultJson(await ownerClient.client.callTool({ name: 'request_rollback', arguments: { releaseID: currentRelease.id } })) as { changeSet: { id: string; state: string } }; preparedID = prepared.changeSet.id
    expect(prepared.changeSet).toMatchObject({ state: 'open' })
    expect(await payload.findByID({ collection: 'change-sets', id: prepared.changeSet.id, overrideAccess: true })).toMatchObject({ name: `Rollback release #${sequence + 1}`, state: 'open' })
  } finally {
    await Promise.all([ownerClient.transport.close(), ownerReadClient.transport.close(), editorClient.transport.close(), staleClient.transport.close(), revokedClient.transport.close()])
    const releases = [oldRelease, currentRelease]; const snapshots = releases.map((release) => typeof release.snapshot === 'string' ? release.snapshot : release.snapshot.id); const outboxes = releases.map((release) => typeof release.outbox === 'string' ? release.outbox : release.outbox.id)
    await withPayloadTransaction(payload, async (req) => {
      await payload.delete({ collection: 'published-releases', where: { id: { in: releases.map((release) => release.id) } }, overrideAccess: true, req, context: { editorialInternal: true } })
      await payload.delete({ collection: 'publish-outbox', where: { id: { in: outboxes } }, overrideAccess: true, req, context: { editorialInternal: true } })
      await payload.delete({ collection: 'publish-snapshots', where: { id: { in: snapshots } }, overrideAccess: true, req, context: { editorialInternal: true } })
      await payload.delete({ collection: 'change-sets', where: { or: [{ name: { equals: 'MCP rollback previous' } }, { name: { equals: 'MCP rollback current' } }, ...(preparedID ? [{ id: { equals: preparedID } }] : [])] }, overrideAccess: true, req, context: { editorialInternal: true } })
      // Requesting rollback reconciles the captured snapshot into ordinary draft
      // records. Restore the pre-existing settings before removing this test's
      // synthetic page and section, so later upload tests never inherit a
      // dangling homepage relationship.
      if (originalSiteSettings) {
        const { id, createdAt, updatedAt, ...data } = originalSiteSettings
        await payload.update({ collection: 'site-settings', id: String(id), data: data as never, draft: true, overrideAccess: true, req, context: { editorialInternal: true } })
      }
      await payload.delete({ collection: 'pages', where: { id: { equals: rollbackPageID } }, overrideAccess: true, req, context: { editorialInternal: true } })
      await payload.delete({ collection: 'sections', where: { id: { equals: rollbackSectionID } }, overrideAccess: true, req, context: { editorialInternal: true } })
    })
  }
})

test('ENG-017 creates and updates draft pages only through an explicit revisioned change set', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: 'mcp-page@example.test', name: 'MCP Page Editor', roles: ['editor'] }, overrideAccess: true })
  const section = await payload.create({ collection: 'sections', data: { name: 'MCP pages', summary: 'Synthetic section that accepts standard pages for MCP mutation testing.', slug: 'mcp-pages', allowedTemplates: ['standard'] }, user: editor, overrideAccess: false })
  const session = await sessionFor(editor.id); tokens.set('page-token', { clientId: 'page-client', userId: editor.id, sessionId: session.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  const sdk = await clientFor('page-token')
  try {
    const set = resultJson(await sdk.client.callTool({ name: 'create_change_set', arguments: { name: 'Page MCP' } })) as { id: string; revision: number }
    const args = { changeSetId: set.id, expectedChangeSetRevision: set.revision, requestKey: '50000000-0000-4000-8000-000000000001', title: 'MCP page', summary: 'Synthetic page written by a real MCP SDK client inside a selected change set.', slug: 'mcp-page', sectionId: section.id, template: 'standard' }
    const created = resultJson(await sdk.client.callTool({ name: 'create_page', arguments: args })) as { id: string }
    expect(created.id).toBe(args.requestKey)
    expect(resultJson(await sdk.client.callTool({ name: 'create_page', arguments: args }))).toMatchObject({ id: created.id })
    expect(resultJson(await sdk.client.callTool({ name: 'create_page', arguments: { ...args, title: 'Conflicting retry' } }))).toMatchObject({ error: 'revision_conflict' })
    expect((await payload.find({ collection: 'pages', where: { id: { equals: created.id } }, overrideAccess: true })).totalDocs).toBe(1)
    const changed = await payload.findByID({ collection: 'change-sets', id: set.id, overrideAccess: true })
    const updated = resultJson(await sdk.client.callTool({ name: 'update_page', arguments: { id: created.id, changeSetId: set.id, expectedChangeSetRevision: changed.revision, title: 'MCP page revised' } })) as { title: string }
    expect(updated.title).toBe('MCP page revised')
    const before = await payload.find({ collection: 'pages', where: { id: { equals: created.id } }, overrideAccess: true })
    expect(resultJson(await sdk.client.callTool({ name: 'update_page', arguments: { id: created.id, changeSetId: set.id, expectedChangeSetRevision: 0, title: 'stale' } }))).toMatchObject({ error: 'revision_conflict' })
    expect((await payload.find({ collection: 'pages', where: { id: { equals: created.id } }, overrideAccess: true })).docs[0]?.title).toBe(before.docs[0]?.title)
  } finally { await sdk.transport.close() }
})

test('an Approver grant updates existing pages but cannot create pages or approve', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: `approver-fixture-editor-${randomUUID()}@example.test`, name: 'Approver fixture editor', roles: ['editor'] }, overrideAccess: true })
  const approver = await payload.create({ collection: 'users', data: { email: `approver-writer-${randomUUID()}@example.test`, name: 'Approver writer', roles: ['approver'] }, overrideAccess: true })
  const section = await payload.create({ collection: 'sections', data: { name: 'Approver MCP pages', summary: 'Synthetic section used to verify bounded Approver page editing through MCP.', slug: `approver-mcp-${randomUUID().slice(0, 8)}`, allowedTemplates: ['standard'] }, user: editor, overrideAccess: false })
  const page = await payload.create({ collection: 'pages', data: { title: 'Approver MCP original', summary: 'Synthetic existing page that an Approver may revise through a scoped assistant.', slug: `approver-page-${randomUUID().slice(0, 8)}`, sectionId: section.id, template: 'standard', blocks: [] }, user: editor, overrideAccess: false })
  const session = await sessionFor(approver.id)
  tokens.set('approver-write-token', { clientId: 'approver-write-client', userId: approver.id, sessionId: session.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  const sdk = await clientFor('approver-write-token')
  try {
    const set = resultJson(await sdk.client.callTool({ name: 'create_change_set', arguments: { name: 'Approver MCP page revision' } })) as { id: string; revision: number }
    const updated = resultJson(await sdk.client.callTool({ name: 'update_page', arguments: { id: page.id, changeSetId: set.id, expectedChangeSetRevision: set.revision, title: 'Approver MCP revised' } })) as { title: string }
    expect(updated.title).toBe('Approver MCP revised')
    const captured = await payload.findByID({ collection: 'change-sets', id: set.id, overrideAccess: true })
    expect(captured).toMatchObject({ actor: expect.objectContaining({ id: approver.id }), revision: 1 })
    expect(resultJson(await sdk.client.callTool({ name: 'create_page', arguments: { changeSetId: set.id, expectedChangeSetRevision: captured.revision, requestKey: randomUUID(), title: 'Denied Approver create', summary: 'This valid page must remain outside the Approver creation permission boundary.', slug: `denied-${randomUUID().slice(0, 8)}`, sectionId: section.id, template: 'standard' } }))).toMatchObject({ error: 'write_failed' })
    expect((await sdk.client.listTools()).tools.map((tool) => tool.name)).not.toContain('approve_change_set')
    expect(resultJson(await sdk.client.callTool({ name: 'submit_change_set', arguments: { id: set.id, expectedRevision: captured.revision } }))).toMatchObject({ state: 'submitted', revision: 2 })
  } finally {
    await sdk.transport.close()
  }
})

test('MCP media search retains tagged used assets past the first 100 results', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: `mcp-media-pagination-${randomUUID()}@example.test`, name: 'MCP Media Pagination', roles: ['editor'] }, overrideAccess: true })
  const section = await payload.create({ collection: 'sections', data: { name: `MCP media pagination ${randomUUID()}`, summary: 'Synthetic section for MCP media pagination coverage.', slug: `mcp-media-pagination-${randomUUID().slice(0, 8)}`, allowedTemplates: ['standard'] }, user: editor, overrideAccess: false })
  const tag = `mcp-pagination-${randomUUID()}`
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#124' } }).png().toBuffer()
  const assets: Array<{ id: string }> = []
  for (let index = 0; index < 101; index++) assets.push(await payload.create({
    collection: 'assets', data: { alt: `MCP pagination asset ${index}`, decorative: false, tags: [tag] },
    file: { data: bytes, mimetype: 'image/png', name: `mcp-pagination-${index}.png`, size: bytes.length }, user: editor, overrideAccess: false,
  }) as { id: string })
  const lateAsset = assets[100]!
  const appearance = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } as const
  await payload.create({
    collection: 'pages',
    data: {
      title: 'MCP media pagination references', summary: 'Synthetic page that references every paginated media fixture asset.', slug: `mcp-media-references-${randomUUID().slice(0, 8)}`, sectionId: section.id, template: 'standard',
      blocks: Array.from({ length: Math.ceil(assets.length / 12) }, (_, group) => ({ id: randomUUID(), type: 'gallery', mediaIds: assets.slice(group * 12, group * 12 + 12).map((asset) => asset.id), hidden: false, appearance })),
    }, user: editor, overrideAccess: false,
  })
  const session = await sessionFor(editor.id)
  tokens.set('mcp-media-pagination', { clientId: 'mcp-media-pagination-client', userId: editor.id, sessionId: session.id, scopes: ['mcp:content:read'] })
  const sdk = await clientFor('mcp-media-pagination')
  try {
    const first = resultJson(await sdk.client.callTool({ name: 'find_media', arguments: { tag, usage: 'used', page: 1, pageSize: 25 } })) as { assets: Array<{ id: string }>; total: number; page: number; pageSize: number; totalPages: number }
    expect(first).toMatchObject({ total: 101, page: 1, pageSize: 25, totalPages: 5 })
    const pages = [first]
    for (let page = 2; page <= first.totalPages; page++) pages.push(resultJson(await sdk.client.callTool({ name: 'find_media', arguments: { tag, usage: 'used', page, pageSize: 25 } })) as typeof first)
    const foundIDs = pages.flatMap((found) => found.assets.map((asset) => asset.id))
    expect(foundIDs).toHaveLength(101)
    expect(new Set(foundIDs)).toEqual(new Set(assets.map((asset) => asset.id)))
    expect(foundIDs).toContain(lateAsset.id)
    expect(resultJson(await sdk.client.callTool({ name: 'get_media_usage', arguments: { id: lateAsset.id } }))).toMatchObject({ id: lateAsset.id, usages: [expect.objectContaining({ locations: expect.arrayContaining([expect.stringContaining('mediaIds')]) })] })
  } finally { await sdk.transport.close() }
}, 180_000)

test('MCP update_media reports a retryable SQLite writer lock without a partial mutation', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: `mcp-media-busy-${randomUUID()}@example.test`, name: 'MCP Media Busy', roles: ['editor'] }, overrideAccess: true })
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#124' } }).png().toBuffer()
  const asset = await payload.create({ collection: 'assets', data: { alt: 'Original locked media metadata', decorative: false, tags: ['before-lock'] }, file: { data: bytes, mimetype: 'image/png', name: 'mcp-media-busy.png', size: bytes.length }, user: editor, overrideAccess: false })
  const session = await sessionFor(editor.id)
  tokens.set('mcp-media-busy', { clientId: 'mcp-media-busy-client', userId: editor.id, sessionId: session.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  const sdk = await clientFor('mcp-media-busy')
  const set = resultJson(await sdk.client.callTool({ name: 'create_change_set', arguments: { name: 'MCP media busy mutation' } })) as { id: string; revision: number }
  const originalCreate = payload.create.bind(payload)
  const external = createClient({ url: `file:${join(directory, 'cms.sqlite')}` })
  let lock: Awaited<ReturnType<typeof external.transaction>> | undefined
  let armed = true
  ;(payload as unknown as { create: typeof payload.create }).create = (async (args: Parameters<typeof payload.create>[0]) => {
    const result = await originalCreate(args)
    if (armed && args.collection === 'audit-events' && (args.data as { event?: unknown }).event === 'mcp.request') {
      armed = false; lock = await external.transaction('write')
      await lock.execute({ sql: 'UPDATE users SET updated_at = updated_at WHERE id = ?', args: [String(editor.id)] })
    }
    return result
  }) as typeof payload.create
  try {
    const blocked = await sdk.client.callTool({ name: 'update_media', arguments: { id: asset.id, changeSetId: set.id, expectedChangeSetRevision: set.revision, alt: 'Locked metadata must not persist', decorative: false, tags: ['after-lock'], focalX: 25, focalY: 75 } })
    expect(blocked).toMatchObject({ isError: true })
    expect(resultJson(blocked)).toEqual({ error: 'temporarily_unavailable', retryAfterSeconds: 1 })
    await lock?.rollback(); lock = undefined
    expect(await payload.findByID({ collection: 'assets', id: asset.id, overrideAccess: true })).toMatchObject({ alt: 'Original locked media metadata', tags: ['before-lock'] })
    expect(await payload.findByID({ collection: 'change-sets', id: set.id, overrideAccess: true })).toMatchObject({ revision: set.revision })
  } finally {
    ;(payload as unknown as { create: typeof payload.create }).create = originalCreate as typeof payload.create
    await lock?.rollback(); external.close()
    await sdk.transport.close()
  }
}, 15_000)

test('MCP media tools use scoped effective users and revisioned metadata writes', async () => {
  const editor = await payload.create({ collection: 'users', data: { email: `mcp-media-editor-${randomUUID()}@example.test`, name: 'MCP Media Editor', roles: ['editor'] }, overrideAccess: true })
  const approver = await payload.create({ collection: 'users', data: { email: `mcp-media-approver-${randomUUID()}@example.test`, name: 'MCP Media Approver', roles: ['approver'] }, overrideAccess: true })
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#124' } }).png().toBuffer()
  const asset = await payload.create({ collection: 'assets', data: { alt: 'Original media metadata', decorative: false }, file: { data: bytes, mimetype: 'image/png', name: 'mcp-media.png', size: bytes.length }, user: editor, overrideAccess: false })
  const [editorSession, approverSession] = await Promise.all([sessionFor(editor.id), sessionFor(approver.id)])
  tokens.set('mcp-media-editor', { clientId: 'mcp-media-editor-client', userId: editor.id, sessionId: editorSession.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  tokens.set('mcp-media-approver', { clientId: 'mcp-media-approver-client', userId: approver.id, sessionId: approverSession.id, scopes: ['mcp:content:read', 'mcp:content:write'] })
  const [writer, reader] = await Promise.all([clientFor('mcp-media-editor'), clientFor('mcp-media-approver')])
  try {
    const found = resultJson(await writer.client.callTool({ name: 'find_media', arguments: { q: 'Original media' } })) as { assets: Array<{ id: string }> }
    expect(found.assets).toEqual(expect.arrayContaining([expect.objectContaining({ id: asset.id })]))
    expect(resultJson(await writer.client.callTool({ name: 'get_media_usage', arguments: { id: asset.id } }))).toEqual({ id: asset.id, usages: [] })
    const set = resultJson(await writer.client.callTool({ name: 'create_change_set', arguments: { name: 'MCP media metadata' } })) as { id: string; revision: number }
    const saved = resultJson(await writer.client.callTool({ name: 'update_media', arguments: { id: asset.id, changeSetId: set.id, expectedChangeSetRevision: set.revision, alt: 'Original media metadata', decorative: false, caption: 'Captured media caption', credit: 'Captured media credit', focalX: 50, focalY: 50, tags: ['mcp'] } })) as { draft: { assetId: string; changeSetRevision: number }; checks: unknown[] }
    expect(saved).toMatchObject({ draft: { assetId: asset.id, changeSetRevision: set.revision + 1 }, checks: [{ name: 'contract-and-tree', status: 'passed', errors: [] }] })
    expect(await payload.findByID({ collection: 'change-sets', id: set.id, overrideAccess: true })).toMatchObject({ changes: [expect.objectContaining({ collection: 'assets', id: asset.id, after: expect.objectContaining({ caption: 'Captured media caption', credit: 'Captured media credit', tags: ['mcp'] }) })] })
    await expect(writer.client.callTool({ name: 'update_media', arguments: { id: asset.id, changeSetId: set.id, expectedChangeSetRevision: saved.draft.changeSetRevision, alt: 'invalid', decorative: false, focalX: 50, focalY: 50, unknown: true } })).resolves.toMatchObject({ isError: true })
    expect(await payload.findByID({ collection: 'assets', id: asset.id, overrideAccess: true })).toMatchObject({ alt: 'Original media metadata', caption: 'Captured media caption', credit: 'Captured media credit', tags: ['mcp'] })
    await withPayloadTransaction(payload, async (req) => { req.user = editor as never; await transitionChangeSet({ payload, req, actor: editor, id: set.id, action: 'discard' }) })
    expect(await payload.findByID({ collection: 'assets', id: asset.id, overrideAccess: true })).toMatchObject({ alt: 'Original media metadata', caption: null, credit: null, tags: [] })
    expect(resultJson(await reader.client.callTool({ name: 'update_media', arguments: { id: asset.id, changeSetId: set.id, expectedChangeSetRevision: saved.draft.changeSetRevision, alt: 'Denied metadata update', decorative: false, focalX: 50, focalY: 50 } }))).toEqual({ error: 'role_access_required' })
    expect(await payload.findByID({ collection: 'assets', id: asset.id, overrideAccess: true })).toMatchObject({ alt: 'Original media metadata', tags: [] })
  } finally { await Promise.all([writer.transport.close(), reader.transport.close()]) }
})


test('MCP prepare_reply is scoped, draft-only, and returns only the exact review envelope', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: `mcp-reply-owner-${randomUUID()}@example.test`, name: 'Reply Owner', roles: ['owner'] }, overrideAccess: true })
  const sales = await payload.create({ collection: 'users', data: { email: `mcp-reply-sales-${randomUUID()}@example.test`, name: 'Reply Sales', roles: ['sales'] }, overrideAccess: true })
  const hiring = await payload.create({ collection: 'users', data: { email: `mcp-reply-hiring-${randomUUID()}@example.test`, name: 'Reply Hiring', roles: ['hiring'] }, overrideAccess: true })
  const lead = await payload.create({ collection: 'inquiries', data: { email: `mcp-reply-lead-${randomUUID()}@example.test`, name: 'Private lead', telephone: '+1 416 555 0199', message: 'Untrusted visitor message.', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: randomUUID(), stage: 'new' }, overrideAccess: true })
  const application = await payload.create({ collection: 'applications', data: { name: 'Private applicant', email: `mcp-reply-application-${randomUUID()}@example.test`, telephone: '+1 416 555 0100', coverLetter: 'Private application cover letter.', consent: true, jobId: randomUUID(), resumeKey: `${randomUUID()}-${'b'.repeat(64)}`, idempotencyKey: randomUUID(), status: 'new' }, overrideAccess: true })
  const [ownerSession, salesSession, hiringSession] = await Promise.all([sessionFor(owner.id), sessionFor(sales.id), sessionFor(hiring.id)])
  tokens.set('reply-content-only', { clientId: 'reply-content-only', userId: owner.id, sessionId: ownerSession.id, scopes: ['mcp:content:read'] })
  tokens.set('reply-sales', { clientId: 'reply-sales', userId: sales.id, sessionId: salesSession.id, scopes: ['mcp:leads:read', 'mcp:leads:reply'] })
  tokens.set('reply-hiring', { clientId: 'reply-hiring', userId: hiring.id, sessionId: hiringSession.id, scopes: ['mcp:careers:read', 'mcp:careers:reply'] })
  const contentOnly = await clientFor('reply-content-only'); const salesClient = await clientFor('reply-sales'); const hiringClient = await clientFor('reply-hiring')
  try {
    const denied = await contentOnly.client.callTool({ name: 'prepare_reply', arguments: { target: 'lead', id: lead.id, sender: 'site@example.test', subject: 'Private subject', body: 'Private body' } })
    expect(resultJson(denied)).toEqual({ error: 'insufficient_scope', required: 'mcp:leads:reply' })
    const leadDraft = resultJson(await salesClient.client.callTool({ name: 'prepare_reply', arguments: { target: 'lead', id: lead.id, sender: 'site@example.test', subject: 'A precise follow-up', body: 'A prepared response only.' } })) as { draft: { id: string; target: string; sender: string; recipient: string; subject: string; body: string; revision: number; state: string } }
    expect(leadDraft.draft).toMatchObject({ id: expect.any(String), target: 'lead', revision: 1, state: 'prepared', confirmationURL: expect.stringMatching(/\/leads\?lead=.*&draft=/) })
    expect(JSON.stringify(leadDraft)).not.toContain('A prepared response only.')
    expect(JSON.stringify(leadDraft)).not.toContain('+1 416 555 0199')
    expect(JSON.stringify(leadDraft)).not.toContain('4165550199')
    expect(Object.keys(leadDraft.draft).sort()).toEqual(['attachments', 'confirmationURL', 'id', 'revision', 'state', 'target'])
    expect((await payload.find({ collection: 'mail-authorizations', where: { draft: { equals: leadDraft.draft.id } }, limit: 0, pagination: false, overrideAccess: true })).totalDocs).toBe(0)
    const applicationDenied = await salesClient.client.callTool({ name: 'prepare_reply', arguments: { target: 'application', id: application.id, sender: 'site@example.test', subject: 'No access', body: 'No access.' } })
    expect(resultJson(applicationDenied)).toEqual({ error: 'insufficient_scope', required: 'mcp:careers:reply' })
    const applicationDraft = resultJson(await hiringClient.client.callTool({ name: 'prepare_reply', arguments: { target: 'application', id: application.id, sender: 'site@example.test', subject: 'Interview details', body: 'A prepared hiring response only.' } })) as { draft: { target: string; state: string } }
    expect(applicationDraft.draft).toMatchObject({ target: 'application', state: 'prepared' })
  } finally { await Promise.all([contentOnly.transport.close(), salesClient.transport.close(), hiringClient.transport.close()]) }
})

test('MCP reply grants bind the SDK origin to a separate fresh human confirmation and refuse every invalidated send before delivery', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: `mcp-bound-owner-${randomUUID()}@example.test`, name: 'Bound reply owner', roles: ['owner'] }, overrideAccess: true })
  const other = await payload.create({ collection: 'users', data: { email: `mcp-bound-other-${randomUUID()}@example.test`, name: 'Other reply owner', roles: ['owner'] }, overrideAccess: true })
  const lead = await payload.create({ collection: 'inquiries', data: { email: `mcp-bound-lead-${randomUUID()}@example.test`, name: 'Bound lead', message: 'Please reply through the confirmed channel.', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: randomUUID(), stage: 'new' }, overrideAccess: true })
  const originSession = await sessionFor(owner.id)
  const confirmationToken = newOpaqueToken()
  const confirmationSession = await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(confirmationToken), user: owner.id, authenticatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() }, overrideAccess: true })
  const otherSession = await sessionFor(other.id)
  const clientID = `mcp-bound-client-${randomUUID()}`
  const clientHash = createHash('sha256').update(clientID).digest('hex')
  const tokenName = `mcp-bound-token-${randomUUID()}`
  tokens.set(tokenName, { clientId: clientID, userId: owner.id, sessionId: originSession.id, scopes: ['mcp:leads:read', 'mcp:leads:reply'] })
  const sdk = await clientFor(tokenName)
  let providerRequests = 0
  setReplyDeliveryForTest(async (_payload, area, envelope) => {
    providerRequests += 1
    expect(area).toBe('leads')
    expect(envelope).toMatchObject({ sender: 'team@example.test', recipient: lead.email, subject: 'SDK-bound subject', body: 'SDK-bound body' })
    return { provider: 'smtp', messageID: `mcp-bound-${providerRequests}` }
  })
  const prepareAndConfirm = async () => {
    const prepared = structuredJson(await sdk.client.callTool({ name: 'prepare_reply', arguments: { target: 'lead', id: lead.id, sender: 'team@example.test', subject: 'SDK-bound subject', body: 'SDK-bound body' } })) as { draft: { id: string; confirmationURL: string } }
    const deepLink = new URL(prepared.draft.confirmationURL)
    // This is the exact browser target which a signed-in human sees; it must not
    // silently select the first lead when the requested lead is beyond a page.
    expect(deepLink.pathname).toBe('/leads')
    expect(deepLink.searchParams.get('lead')).toBe(lead.id)
    expect(deepLink.searchParams.get('draft')).toBe(prepared.draft.id)
    const grant = await authorizeMailDraft(payload, { id: owner.id, sessionToken: confirmationToken }, prepared.draft.id, new Date(Date.now() + 60_000))
    expect(grant).toMatchObject({ authorizedBy: expect.objectContaining({ id: owner.id }), humanConfirmationSessionID: confirmationSession.id, assistantClientIDHash: clientHash, assistantActor: expect.objectContaining({ id: owner.id }), assistantOAuthSessionID: originSession.id })
    return { draftID: prepared.draft.id, grantID: grant.id }
  }
  const assertRejected = async (draftID: string, grantID: string) => {
    let rejected: { error: string } | undefined
    try { rejected = resultJson(await sdk.client.callTool({ name: 'send_reply', arguments: { draftID, grantID } })) as { error: string } } catch { /* Disabled canonical actors are rejected at MCP authentication before a tool result exists. */ }
    if (rejected) expect(rejected.error).toMatch(/authorization_not_usable|mail_authorization_required|insufficient_scope/)
    expect(providerRequests).toBe(1)
    expect(await payload.findByID({ collection: 'mail-authorizations', id: grantID, depth: 0, overrideAccess: true })).toMatchObject({ consumedAt: null })
  }
  try {
    const accepted = await prepareAndConfirm()
    const pending = structuredJson(await sdk.client.callTool({ name: 'get_reply_status', arguments: { draftID: accepted.draftID } })) as { grantID: string | null }
    expect(pending.grantID).toBe(accepted.grantID)
    expect(structuredJson(await sdk.client.callTool({ name: 'send_reply', arguments: accepted }))).toMatchObject({ provider: 'smtp', messageID: 'mcp-bound-1' })
    expect(providerRequests).toBe(1)

    const cases: Array<[string, (draftID: string, grantID: string) => Promise<void>]> = [
      ['wrong client', async () => { tokens.set(tokenName, { clientId: `wrong-client-${randomUUID()}`, userId: owner.id, sessionId: originSession.id, scopes: ['mcp:leads:read', 'mcp:leads:reply'] }) }],
      ['wrong actor', async () => { tokens.set(tokenName, { clientId: clientID, userId: other.id, sessionId: otherSession.id, scopes: ['mcp:content:read', 'mcp:leads:read', 'mcp:leads:reply'] }) }],
      ['wrong OAuth origin session', async () => { tokens.set(tokenName, { clientId: clientID, userId: owner.id, sessionId: (await sessionFor(owner.id)).id, scopes: ['mcp:content:read', 'mcp:leads:read', 'mcp:leads:reply'] }) }],
      ['edited draft', async (draftID) => { await payload.update({ collection: 'mail-drafts', id: draftID, data: { body: 'Edited after confirmation.' }, overrideAccess: true }) }],
      ['canceled draft', async (draftID, grantID) => { await payload.update({ collection: 'mail-authorizations', id: grantID, data: { revokedAt: new Date().toISOString() }, overrideAccess: true }); await payload.update({ collection: 'mail-drafts', id: draftID, data: { state: 'canceled' }, overrideAccess: true }) }],
      ['expired grant', async (_draftID, grantID) => { await payload.update({ collection: 'mail-authorizations', id: grantID, data: { expiresAt: new Date(Date.now() - 1_000).toISOString() }, overrideAccess: true }) }],
      ['revoked human confirmation session', async () => { await payload.update({ collection: 'auth-sessions', id: confirmationSession.id, data: { revokedAt: new Date().toISOString() }, overrideAccess: true }) }],
      ['stale human confirmation session', async () => { await payload.update({ collection: 'auth-sessions', id: confirmationSession.id, data: { authenticatedAt: new Date(Date.now() - 16 * 60_000).toISOString() }, overrideAccess: true }) }],
      ['demoted canonical actor', async () => { await payload.update({ collection: 'users', id: owner.id, data: { roles: ['editor'] }, overrideAccess: true }) }],
    ]
    for (const [name, invalidate] of cases) {
      await payload.update({ collection: 'users', id: owner.id, data: { disabled: false, roles: ['owner'] }, overrideAccess: true })
      await payload.update({ collection: 'auth-sessions', id: confirmationSession.id, data: { revokedAt: null, authenticatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() }, overrideAccess: true })
      tokens.set(tokenName, { clientId: clientID, userId: owner.id, sessionId: originSession.id, scopes: ['mcp:leads:read', 'mcp:leads:reply'] })
      const rejected = await prepareAndConfirm()
      await invalidate(rejected.draftID, rejected.grantID)
      await assertRejected(rejected.draftID, rejected.grantID)
      expect(providerRequests, name).toBe(1)
    }
    await payload.update({ collection: 'users', id: owner.id, data: { disabled: false, roles: ['owner'] }, overrideAccess: true })
    const disabledConfirmationToken = newOpaqueToken()
    await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(disabledConfirmationToken), user: owner.id, authenticatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() }, overrideAccess: true })
    const disabledDraft = await prepareReply(payload, 'lead', lead.id, owner.id, { sender: 'team@example.test', subject: 'Disabled actor subject', body: 'Disabled actor body' }, { clientIDHash: clientHash, actorID: owner.id, oauthSessionID: originSession.id })
    const disabledGrant = await authorizeMailDraft(payload, { id: owner.id, sessionToken: disabledConfirmationToken }, disabledDraft.id, new Date(Date.now() + 60_000))
    await payload.update({ collection: 'users', id: owner.id, data: { disabled: true }, overrideAccess: true })
    const disabledResponse = await fetch(`${mcpOrigin}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokenName}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: 'send_reply', arguments: { draftID: disabledDraft.id, grantID: disabledGrant.id } } }) })
    expect(disabledResponse.status).toBe(401)
    expect(providerRequests).toBe(1)
    expect(await payload.findByID({ collection: 'mail-authorizations', id: disabledGrant.id, depth: 0, overrideAccess: true })).toMatchObject({ consumedAt: null })
    await payload.update({ collection: 'users', id: owner.id, data: { disabled: false, roles: ['owner'] }, overrideAccess: true })
    let replay: { error: string } | undefined
    try { replay = resultJson(await sdk.client.callTool({ name: 'send_reply', arguments: accepted })) as { error: string } } catch { /* A closed transport is also a refused replay. */ }
    if (replay) expect(replay).toMatchObject({ error: 'authorization_not_usable' })
    expect(providerRequests).toBe(1)
  } finally {
    setReplyDeliveryForTest()
  }
})

test('MCP sends a human-confirmed careers reply with only careers read and reply scopes', async () => {
  const hiring = await payload.create({ collection: 'users', data: { email: `mcp-careers-send-${randomUUID()}@example.test`, name: 'Hiring sender', roles: ['hiring'] }, overrideAccess: true })
  const application = await payload.create({ collection: 'applications', data: { name: 'Careers applicant', email: `mcp-careers-applicant-${randomUUID()}@example.test`, coverLetter: 'Application.', consent: true, jobId: randomUUID(), resumeKey: `${randomUUID()}-${'c'.repeat(64)}`, idempotencyKey: randomUUID(), status: 'new' }, overrideAccess: true })
  const originSession = await sessionFor(hiring.id)
  const confirmationToken = newOpaqueToken()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(confirmationToken), user: hiring.id, authenticatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() }, overrideAccess: true })
  const tokenName = `mcp-careers-send-token-${randomUUID()}`
  tokens.set(tokenName, { clientId: `mcp-careers-send-client-${randomUUID()}`, userId: hiring.id, sessionId: originSession.id, scopes: ['mcp:careers:read', 'mcp:careers:reply'] })
  const sdk = await clientFor(tokenName)
  let deliveries = 0
  setReplyDeliveryForTest(async (_payload, area, envelope) => { deliveries += 1; expect(area).toBe('careers'); expect(envelope).toMatchObject({ recipient: application.email, subject: 'Interview details', body: 'Please choose a time.' }); return { provider: 'smtp', messageID: 'careers-sdk-send' } })
  try {
    const draft = structuredJson(await sdk.client.callTool({ name: 'prepare_reply', arguments: { target: 'application', id: application.id, sender: 'team@example.test', subject: 'Interview details', body: 'Please choose a time.' } })) as { draft: { id: string } }
    const grant = await authorizeMailDraft(payload, { id: hiring.id, sessionToken: confirmationToken }, draft.draft.id, new Date(Date.now() + 60_000))
    expect(structuredJson(await sdk.client.callTool({ name: 'send_reply', arguments: { draftID: draft.draft.id, grantID: grant.id } }))).toMatchObject({ provider: 'smtp', messageID: 'careers-sdk-send' })
    expect(deliveries).toBe(1)
  } finally { setReplyDeliveryForTest(); await sdk.transport.close() }
})
