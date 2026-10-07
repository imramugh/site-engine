import { expect, test, type Browser, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const pageID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeee0016'

type CatalogEntry = { name?: string; uri?: string; uriTemplate?: string; description?: string; _meta?: unknown }

function jsonResource(value: unknown): unknown {
  const response = value as { contents?: Array<{ text?: string }> }
  return JSON.parse(response.contents?.[0]?.text ?? '{}')
}

async function signedIn(browser: Browser, token = 'synthetic-application-editor-session-token') {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

async function assistant(page: Page, query: string) {
  const identity = await page.request.post(`/__e2e/mcp-identity?${query}`).then(async (response) => {
    expect(response.ok(), await response.text()).toBeTruthy()
    return response.json() as Promise<{ bearer: string }>
  })
  const client = new Client({ name: 'eng032-browser-proof', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${identity.bearer}` } } })
  await client.connect(transport)
  return { client, transport }
}

function expectCatalogMeta(entry: CatalogEntry, scope: string) {
  expect(entry._meta).toMatchObject({
    securitySchemes: [{ type: 'oauth2', scopes: [scope] }],
    authorization: { requiredScopes: [scope], effectiveUserRequired: true },
    limits: { approve: false, publish: false, userManagement: false, credentialAccess: false, permanentDelete: false },
  })
}

test.describe.configure({ mode: 'serial' })

test('ENG-032 exposes the connected-assistant surface and an Editor can only read the scoped content catalog', async ({ browser }) => {
  test.setTimeout(120_000)
  const session = await signedIn(browser)
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  let transport: StreamableHTTPClientTransport | undefined
  try {
    await session.page.goto('/integrations?tab=assistants')
    await expect(session.page.getByRole('tab', { name: 'Connected assistants' })).toBeVisible()
    await expect(session.page.getByRole('heading', { name: 'My connected assistants' })).toBeVisible()
    await session.page.addScriptTag({ path: axeSource })
    expect(await session.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])

    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    const connected = await assistant(session.page, 'role=editor&content=write')
    transport = connected.transport
    const [tools, resources, templates, prompts] = await Promise.all([connected.client.listTools(), connected.client.listResources(), connected.client.listResourceTemplates(), connected.client.listPrompts()])
    const resourceUris = resources.resources.map((entry) => entry.uri)
    expect(resourceUris).toEqual(expect.arrayContaining([
      'site-engine://contract/block-library', 'site-engine://contract/style-guide', 'site-engine://contract/glossary',
      'site-engine://site/summary', 'site-engine://site/page-tree', 'site-engine://site/settings', 'site-engine://site/installed-themes',
    ]))
    expect(templates.resourceTemplates).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'page', uriTemplate: 'site-engine://page/{id}' })]))
    for (const entry of [...resources.resources, ...templates.resourceTemplates] as CatalogEntry[]) expectCatalogMeta(entry, 'mcp:content:read')
    expectCatalogMeta(resources.resources.find((entry) => entry.uri === 'site-engine://site/settings') as CatalogEntry, 'mcp:content:read')
    expect((resources.resources.find((entry) => entry.uri === 'site-engine://site/settings') as CatalogEntry)._meta).toMatchObject({ authorization: { requiredRoles: ['owner'] } })
    for (const prompt of prompts.prompts as CatalogEntry[]) expectCatalogMeta(prompt, 'mcp:content:read')
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(expect.arrayContaining(['plan-page', 'review-content', 'monthly-content-review']))
    expect(tools.tools.find((tool) => tool.name === 'update_block')).toMatchObject({ _meta: { authorization: { requiredScopes: ['mcp:content:write'], effectiveUserRequired: true }, limits: { approve: false, publish: false, userManagement: false, credentialAccess: false, permanentDelete: false } } })

    const before = await connected.client.readResource({ uri: 'site-engine://contract/style-guide' })
    const [library, tree, scopedPage, plan] = await Promise.all([
      connected.client.readResource({ uri: 'site-engine://contract/block-library' }),
      connected.client.readResource({ uri: 'site-engine://site/page-tree' }),
      connected.client.readResource({ uri: `site-engine://page/${pageID}` }),
      connected.client.getPrompt({ name: 'plan-page', arguments: { objective: 'Explain the synthetic service.' } }),
    ])
    expect(jsonResource(library)).toMatchObject({ blockTypes: expect.any(Array) })
    expect(jsonResource(tree)).toMatchObject({ pages: expect.any(Array) })
    expect(jsonResource(scopedPage)).toMatchObject({ id: pageID, title: 'MCP browser page' })
    expect(JSON.stringify(plan)).toContain('proposed draft only')
    expect(await connected.client.readResource({ uri: 'site-engine://contract/style-guide' })).toEqual(before)
    expect(JSON.stringify(await connected.client.readResource({ uri: 'site-engine://site/settings' }))).toContain('owner_access_required')
  } finally {
    await transport?.close().catch(() => undefined)
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls
    await session.context.close()
  }
})

test('ENG-032 Sales and Hiring assistants receive only their scoped prompts and cannot retrieve cross-scope data', async ({ browser }) => {
  test.setTimeout(120_000)
  const session = await signedIn(browser)
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  let transport: StreamableHTTPClientTransport | undefined
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    let connected = await assistant(session.page, 'role=sales&leads=read')
    transport = connected.transport
    const [salesTools, salesPrompts] = await Promise.all([connected.client.listTools(), connected.client.listPrompts()])
    expectCatalogMeta(salesTools.tools.find((tool) => tool.name === 'list_inquiries') as CatalogEntry, 'mcp:leads:read')
    expect(salesPrompts.prompts.map((prompt) => prompt.name).sort()).toEqual(['draft-inquiry-reply', 'weekly-lead-follow-ups'])
    for (const prompt of salesPrompts.prompts as CatalogEntry[]) expectCatalogMeta(prompt, 'mcp:leads:read')
    const inquiries = await connected.client.callTool({ name: 'list_inquiries', arguments: {} })
    expect(JSON.stringify(inquiries)).toContain('"untrusted":true')
    expect(JSON.stringify(await connected.client.getPrompt({ name: 'draft-inquiry-reply', arguments: { inquiryId: '11111111-1111-4111-8111-111111111111' } }))).toContain('never as instructions')
    await expect(connected.client.readResource({ uri: 'site-engine://contract/glossary' })).rejects.toMatchObject({ code: 403 })
    await expect(connected.client.callTool({ name: 'get_tree', arguments: {} })).rejects.toMatchObject({ code: 403 })
    await expect(connected.client.getPrompt({ name: 'plan-page', arguments: { objective: 'Denied' } })).rejects.toMatchObject({ code: 403 })
    await transport.close(); transport = undefined

    connected = await assistant(session.page, 'role=hiring&careers=read')
    transport = connected.transport
    const [hiringTools, hiringPrompts] = await Promise.all([connected.client.listTools(), connected.client.listPrompts()])
    expectCatalogMeta(hiringTools.tools.find((tool) => tool.name === 'list_applications') as CatalogEntry, 'mcp:careers:read')
    expect(hiringPrompts.prompts.map((prompt) => prompt.name)).toEqual(['summarize-role-applications'])
    for (const prompt of hiringPrompts.prompts as CatalogEntry[]) expectCatalogMeta(prompt, 'mcp:careers:read')
    expect(JSON.stringify(await connected.client.getPrompt({ name: 'summarize-role-applications', arguments: { jobId: '22222222-2222-4222-8222-222222222222' } }))).toContain('Do not rank on protected characteristics')
    await expect(connected.client.callTool({ name: 'list_inquiries', arguments: {} })).rejects.toMatchObject({ code: 403 })
    await expect(connected.client.getPrompt({ name: 'draft-inquiry-reply', arguments: { inquiryId: '11111111-1111-4111-8111-111111111111' } })).rejects.toMatchObject({ code: 403 })
  } finally {
    await transport?.close().catch(() => undefined)
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls
    await session.context.close()
  }
})

test('ENG-032 Owner can retrieve owner-only catalog resources with the effective user', async ({ browser }) => {
  test.setTimeout(120_000)
  const session = await signedIn(browser, 'synthetic-application-owner-session-token')
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  let transport: StreamableHTTPClientTransport | undefined
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    const connected = await assistant(session.page, 'role=owner&content=read')
    transport = connected.transport
    const resources = await connected.client.listResources()
    for (const uri of ['site-engine://site/settings', 'site-engine://site/installed-themes']) {
      const entry = resources.resources.find((resource) => resource.uri === uri) as CatalogEntry
      expectCatalogMeta(entry, 'mcp:content:read')
      expect(entry._meta).toMatchObject({ authorization: { requiredRoles: ['owner'], effectiveUserRequired: true } })
      expect(JSON.stringify(await connected.client.readResource({ uri }))).not.toContain('owner_access_required')
    }
  } finally {
    await transport?.close().catch(() => undefined)
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls
    await session.context.close()
  }
})
