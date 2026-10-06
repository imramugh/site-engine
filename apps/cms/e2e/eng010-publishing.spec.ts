import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import { readyAndApprove, reviewer } from './eng010-publishing.fixture'
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

test('ENG-010 publishes an approved snapshot, retains it after terminal failure, and alerts its Owner', async ({ browser }) => {
  test.setTimeout(90_000)
  const session = await reviewer(browser)
  let jobs: string[] = []
  try {
    const publishedSet = await readyAndApprove(session.page)
    const published = await session.page.request.post(`/__e2e/eng010-publish/success?changeSet=${publishedSet}`)
    expect(published.status(), await published.text()).toBe(200)
    const completed = await published.json() as { claim: { id: string; changeSetID: string; contentHash: string }; health: { contentHash: string } }
    expect(completed).toMatchObject({ claim: { changeSetID: publishedSet }, job: { status: 'completed' }, stages: expect.arrayContaining(['dispatched', 'building', 'built', 'activating']), served: expect.stringContaining('Original review heading') })
    expect(completed.health.contentHash).toBe(completed.claim.contentHash)
    jobs.push(completed.claim.id)
    const failedSet = await readyAndApprove(session.page)
    const before = await session.page.request.get('/__e2e/publish-state').then(response => response.json()) as { releaseCount: number }
    const failed = await session.page.request.post(`/__e2e/eng010-publish/fail?changeSet=${failedSet}`)
    expect(failed.status(), await failed.text()).toBe(200)
    const body = await failed.json() as { claim: { changeSetID: string; id: string }; health: { jobID: string; contentHash: string }; notification: { sourceID: string }; smtp: string | null }
    expect(body).toMatchObject({ claim: { changeSetID: failedSet }, job: { status: 'failed' }, releases: before.releaseCount, served: expect.stringContaining('Original review heading'), notification: { sourceID: body.claim.id, state: 'queued' }, smtp: expect.stringContaining('Publish build failed') })
    expect(body.smtp).toContain(`publish=${body.claim.id}`)
    expect(body.health).toMatchObject({ jobID: completed.claim.id, contentHash: completed.claim.contentHash })
    jobs.push(body.claim.id)
    const owner = await browser.newContext({ baseURL: 'https://127.0.0.1:' + Number(process.env.CMS_E2E_PORT ?? 4300), ignoreHTTPSErrors: true }); await owner.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-operations-owner-session-token', url: 'https://127.0.0.1:' + Number(process.env.CMS_E2E_PORT ?? 4300), secure: true, httpOnly: true, sameSite: 'Lax' as const }))); const page = await owner.newPage()
    await page.goto('/operations')
    const successfulLink = page.getByRole('link', { name: 'Open build log', exact: true }).and(page.locator(`a[href="/operations?publish=${completed.claim.id}"]`))
    await expect(successfulLink).toBeVisible()
    await successfulLink.click()
    const successfulLog = page.getByRole('region', { name: 'Build log', exact: true })
    for (const stage of ['dispatched', 'building', 'built', 'activating', 'deployed']) await expect(successfulLog).toContainText(stage)
    for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) { await page.setViewportSize(size); await page.goto('/operations'); await page.getByRole('link', { name: 'Open build log', exact: true }).and(page.locator(`a[href="/operations?publish=${body.claim.id}"]`)).click(); await expect(page.getByRole('region', { name: 'Build log' })).toContainText('BUILD_FAILED'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); await page.addScriptTag({ path: axeSource }); expect(await page.evaluate(async () => (await (window as any).axe.run('main')).violations)).toEqual([]) }
    await owner.close()
  } finally { if (jobs.length) { const cleanup = await session.page.request.post('/__e2e/eng010-publish/cleanup?' + jobs.map(job => `job=${encodeURIComponent(job)}`).join('&')); expect(cleanup.ok(), await cleanup.text()).toBe(true) } await session.context.close() }
})
