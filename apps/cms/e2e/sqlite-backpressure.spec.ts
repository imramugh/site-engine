import { createHash } from 'node:crypto'
import { expect, test, type Browser } from '@playwright/test'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const pageID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const blockID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

async function editor(browser: Browser) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: 'synthetic-application-editor-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

test('ENG-036 returns retryable backpressure from the authenticated direct-edit route and recovers after lock release', async ({ browser }) => {
  test.setTimeout(30_000)
  const session = await editor(browser)
  try {
    const current = await session.page.request.get(`/api/pages/${pageID}?draft=true`)
    expect(current.ok(), await current.text()).toBeTruthy()
    const page = await current.json() as { blocks: Array<{ id: string; heading?: string }> }
    const heading = page.blocks.find((block) => block.id === blockID)?.heading
    expect(heading).toEqual(expect.any(String))
    const created = await session.page.request.post('/api/editorial/create', { headers: { origin, 'content-type': 'application/json' }, data: { name: `SQLite browser retry ${crypto.randomUUID()}` } })
    expect(created.ok(), await created.text()).toBeTruthy()
    const set = await created.json() as { id: string }
    const body = { pageID, blockID, field: 'heading', value: 'Saved after SQLite lock release', expectedValueHash: createHash('sha256').update(heading!).digest('hex'), changeSetID: set.id }
    const before = await session.page.request.get(`/api/pages/${pageID}?draft=true`).then((response) => response.json()) as { blocks: Array<{ id: string; heading?: string }> }
    const lock = await session.page.request.post('/__e2e/sqlite-lock')
    expect(lock.status(), await lock.text()).toBe(204)
    const started = Date.now()
    const blocked = await session.page.request.post('/api/editorial/direct-edit', { headers: { origin, 'content-type': 'application/json' }, data: body })
    expect(blocked.status(), await blocked.text()).toBe(503)
    expect(blocked.headers()['retry-after']).toBe('1')
    expect(await blocked.json()).toEqual({ error: 'Saving is temporarily busy. Please retry.' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_000)
    const unchanged = await session.page.request.get(`/api/pages/${pageID}?draft=true`).then((response) => response.json()) as { blocks: Array<{ id: string; heading?: string }> }
    expect(unchanged.blocks.find((block) => block.id === blockID)?.heading).toBe(before.blocks.find((block) => block.id === blockID)?.heading)
    const released = await session.page.request.post('/__e2e/sqlite-lock/release')
    expect(released.status(), await released.text()).toBe(204)
    const retried = await session.page.request.post('/api/editorial/direct-edit', { headers: { origin, 'content-type': 'application/json' }, data: body })
    expect(retried.status(), await retried.text()).toBe(200)
  } finally { await session.page.request.post('/__e2e/sqlite-lock/release').catch(() => undefined); await session.context.close() }
})
