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
    // A held writer lock can also make this read take Payload's retryable
    // error path when its sliding session refresh is due. WAL can otherwise
    // serve the read. Assert either documented response, then prove rollback
    // only after releasing the lock when the page can be read reliably.
    const lockedRead = await session.page.request.get(`/api/pages/${pageID}?draft=true`)
    expect([200, 503]).toContain(lockedRead.status())
    if (lockedRead.status() === 503) await expect(lockedRead.json()).resolves.toEqual({ error: 'Authentication is temporarily unavailable. Please retry.' })
    else expect((await lockedRead.json() as { blocks: Array<{ id: string }> }).blocks).toEqual(expect.any(Array))
    const released = await session.page.request.post('/__e2e/sqlite-lock/release')
    expect(released.status(), await released.text()).toBe(204)
    const unchangedResponse = await session.page.request.get(`/api/pages/${pageID}?draft=true`)
    expect(unchangedResponse.status(), await unchangedResponse.text()).toBe(200)
    const unchanged = await unchangedResponse.json() as { blocks: Array<{ id: string; heading?: string }> }
    expect(unchanged.blocks.find((block) => block.id === blockID)?.heading).toBe(before.blocks.find((block) => block.id === blockID)?.heading)
    const retried = await session.page.request.post('/api/editorial/direct-edit', { headers: { origin, 'content-type': 'application/json' }, data: body })
    expect(retried.status(), await retried.text()).toBe(200)
  } finally { await session.page.request.post('/__e2e/sqlite-lock/release').catch(() => undefined); await session.context.close() }
})


test('ENG-036 rolls back an actual direct-edit change-set transaction when capture fails mid-request', async ({ browser }) => {
  test.setTimeout(30_000)
  const session = await editor(browser)
  try {
    const current = await session.page.request.get(`/api/pages/${pageID}?draft=true`)
    const page = await current.json() as { blocks: Array<{ id: string; heading?: string }> }
    const heading = page.blocks.find((block) => block.id === blockID)?.heading
    expect(heading).toEqual(expect.any(String))
    const created = await session.page.request.post('/api/editorial/create', { headers: { origin, 'content-type': 'application/json' }, data: { name: `SQLite rollback ${crypto.randomUUID()}` } })
    expect(created.ok(), await created.text()).toBeTruthy()
    const set = await created.json() as { id: string }
    const before = await session.page.request.get('/__e2e/direct-edit-state').then((response) => response.json())
    const fault = await session.page.request.post('/__e2e/fail-change-capture')
    expect(fault.status(), await fault.text()).toBe(204)
    const body = { pageID, blockID, field: 'heading', value: 'Must not persist after capture failure', expectedValueHash: createHash('sha256').update(heading!).digest('hex'), changeSetID: set.id }
    const failed = await session.page.request.post('/api/editorial/direct-edit', { headers: { origin, 'content-type': 'application/json' }, data: body })
    expect(failed.status()).toBe(400)
    const after = await session.page.request.get('/__e2e/direct-edit-state').then((response) => response.json())
    expect(after).toEqual(before)
  } finally {
    await session.page.request.post('/__e2e/fail-change-capture/release').catch(() => undefined)
    await session.context.close()
  }
})
