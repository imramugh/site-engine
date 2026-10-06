import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

function resource(result: unknown) {
  const contents = (result as { contents?: Array<{ text?: string }> }).contents
  return JSON.parse(contents?.[0]?.text ?? '{}') as Record<string, unknown>
}

test('ENG-016/032 authenticated assistant discovers scoped resources and prompts from the real MCP route', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({
    name,
    value: 'synthetic-theme-owner-session-token',
    url: origin,
    secure: true,
    httpOnly: true,
    sameSite: 'Lax' as const,
  })))
  const page = await context.newPage()
  const identity = await page.request.post('/__e2e/mcp-identity?content=1').then(async response => {
    expect(response.ok(), await response.text()).toBeTruthy()
    return response.json() as Promise<{ bearer: string }>
  })
  const client = new Client({ name: 'mcp-browser-discovery', version: '1.0.0' })
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  let transport: StreamableHTTPClientTransport | undefined
  try {
    // The browser trusts the synthetic e2e HTTPS server through
    // ignoreHTTPSErrors. The SDK client uses Node's fetch, so scope the
    // matching test-only trust override to this real localhost connection.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${identity.bearer}` } } })
    await client.connect(transport)
    const [resources, prompts] = await Promise.all([client.listResources(), client.listPrompts()])
    expect(resources.resources.map(entry => entry.uri)).toEqual(expect.arrayContaining(['site-engine://contract/style-guide', 'site-engine://catalog/prompts', 'site-engine://site/page-tree']))
    expect(prompts.prompts.map(entry => entry.name)).toEqual(expect.arrayContaining(['plan-page', 'review-content']))
    expect(prompts.prompts.find(entry => entry.name === 'plan-page')?.description).toContain('Required OAuth scope: mcp:content:read')
    const catalog = resource(await client.readResource({ uri: 'site-engine://catalog/prompts' }))
    expect(catalog.prompts).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'plan-page', requiredScope: 'mcp:content:read', effectiveUserRequired: true, limits: { approve: false, publish: false, userManagement: false } })]))
    const planned = await client.getPrompt({ name: 'plan-page', arguments: { objective: 'Describe a neutral service.' } })
    expect(JSON.stringify(planned)).toContain('proposed draft only')
  } finally {
    await transport?.close().catch(() => undefined)
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls
  }

  await page.goto('/integrations?tab=assistants')
  await expect(page.getByRole('heading', { name: /Connected assistants|My connected assistants/ })).toBeVisible()
  await page.addScriptTag({ path: axeSource })
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  await context.close()
})
