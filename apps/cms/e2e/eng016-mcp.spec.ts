import { expect, test, type Browser } from '@playwright/test'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const pageID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeee0016'
const blockID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeee1016'

type Page = {
  id: string
  pageHash: string
  blocks: Array<{ id: string; type: string; heading?: string; body?: string; hidden: boolean; appearance: Record<string, string> }>
}

type ChangeSet = { id: string; state: string; revision: number; changes?: unknown[] }
type DraftResult = { draft: { pageId: string; changeSetId: string; pageHash: string; changeSetRevision: number }; checks: Array<{ name: string; status: string }> }

function result<T>(value: unknown): T {
  const response = value as { structuredContent?: T; content?: Array<{ text?: string }>; toolResult?: { structuredContent?: T; content?: Array<{ text?: string }> } }
  const structured = response.structuredContent ?? response.toolResult?.structuredContent
  if (structured) return structured
  const text = (response.content ?? response.toolResult?.content)?.find((item) => item.text)?.text
  return JSON.parse(text ?? '{}') as T
}

async function signedIn(browser: Browser) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: 'synthetic-application-editor-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

test('ENG-016 Editor assistant discovers, drafts, and submits a revisioned block change without approval or publication', async ({ browser }) => {
  test.setTimeout(120_000)
  const browserSession = await signedIn(browser)
  const identity = await browserSession.page.request.post('/__e2e/mcp-identity?role=editor&content=write').then(async (response) => {
    expect(response.ok(), await response.text()).toBeTruthy()
    return response.json() as Promise<{ bearer: string }>
  })
  const client = new Client({ name: 'eng016-browser-proof', version: '1.0.0' })
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  let transport: StreamableHTTPClientTransport | undefined
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${identity.bearer}` } } })
    await client.connect(transport)

    const tools = await client.listTools()
    const names = tools.tools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(['get_tree', 'get_page', 'create_change_set', 'update_block', 'submit_for_review']))
    for (const forbidden of ['approve', 'approve_change_set', 'publish', 'publish_change_set']) expect(names).not.toContain(forbidden)
    expect(tools.tools.find((tool) => tool.name === 'update_block')?.description).toContain('cannot approve or publish')
    expect(JSON.stringify(tools.tools.find((tool) => tool.name === 'update_block')?._meta)).toContain('mcp:content:write')
    expect(result<{ sections: unknown[] }>(await client.callTool({ name: 'get_tree', arguments: {} })).sections.length).toBeGreaterThan(0)

    const original = result<Page>(await client.callTool({ name: 'get_page', arguments: { id: pageID } }))
    const originalBlock = original.blocks.find((block) => block.id === blockID)
    expect(originalBlock).toMatchObject({ type: 'hero', heading: 'Browser original heading' })
    const changeSet = result<ChangeSet>(await client.callTool({ name: 'create_change_set', arguments: { name: 'ENG-016 assistant review draft' } }))
    expect(changeSet).toMatchObject({ state: 'open', revision: 0 })

    const rejected = await client.callTool({ name: 'update_block', arguments: { pageId: pageID, blockId: blockID, changeSetId: changeSet.id, expectedChangeSetRevision: changeSet.revision, expectedPageHash: original.pageHash, block: { ...originalBlock, heading: 'This unknown parameter must not save.' }, unexpectedParameter: true } })
    expect((rejected as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify(rejected)).toMatch(/unrecognized|unexpected|invalid/i)
    expect(result<Page>(await client.callTool({ name: 'get_page', arguments: { id: pageID } }))).toEqual(original)
    expect(result<ChangeSet>(await client.callTool({ name: 'get_change_set', arguments: { id: changeSet.id } }))).toMatchObject({ id: changeSet.id, state: 'open', revision: 0, changes: [] })

    const saved = result<DraftResult>(await client.callTool({ name: 'update_block', arguments: { pageId: pageID, blockId: blockID, changeSetId: changeSet.id, expectedChangeSetRevision: changeSet.revision, expectedPageHash: original.pageHash, block: { ...originalBlock!, heading: 'Assistant-prepared review heading', body: 'This revisioned MCP draft requires human review before any release.' } } }))
    expect(saved).toMatchObject({ draft: { pageId: pageID, changeSetId: changeSet.id, changeSetRevision: 1 } })
    expect(saved.checks.length).toBeGreaterThan(0)
    expect(saved.checks.every((check) => check.status !== 'failed')).toBe(true)

    const submitted = result<ChangeSet & { checks: Array<{ name: string; status: string }> }>(await client.callTool({ name: 'submit_for_review', arguments: { id: changeSet.id, expectedRevision: saved.draft.changeSetRevision } }))
    expect(submitted).toMatchObject({ id: changeSet.id, state: 'submitted', revision: 2 })
    expect(submitted.checks.length).toBeGreaterThan(0)

    await browserSession.page.goto(`/editorial?changeSet=${changeSet.id}`)
    await expect(browserSession.page.getByRole('heading', { name: 'Reviews' })).toBeVisible()
    const review = browserSession.page.locator('[data-editorial-queue-item]').filter({ hasText: 'ENG-016 assistant review draft' })
    await expect(review).toContainText('submitted')
    await review.click()
    await expect(browserSession.page.getByRole('region', { name: 'Change set detail' })).toContainText('Assistant-prepared review heading')
    await expect(browserSession.page.getByRole('button', { name: /Approve and queue publish/ })).toHaveCount(0)
    await browserSession.page.addScriptTag({ path: axeSource })
    expect(await browserSession.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  } finally {
    await transport?.close().catch(() => undefined)
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls
    await browserSession.context.close()
  }
})
