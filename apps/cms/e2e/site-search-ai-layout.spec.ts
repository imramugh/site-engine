import { expect, test, type Browser, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`

async function ownerPage(browser: Browser) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-site-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

async function axe(page: Page) {
  await page.addScriptTag({ path: axeSource })
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('[data-site-search-ai]', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
}

test('Search and AI presents the source cards truthfully at desktop and mobile sizes', async ({ browser }, testInfo) => {
  test.setTimeout(60_000)
  const owner = await ownerPage(browser)
  const themeDraft = await owner.page.request.post('/api/themes', {
    headers: { origin, 'content-type': 'application/json' },
    data: { id: 'search-browser-theme', version: '1.7.0', changeSetName: 'Search and AI 1.7 browser draft' },
  })
  expect(themeDraft.status(), await themeDraft.text()).toBe(201)

  await owner.page.setViewportSize({ width: 1440, height: 1000 })
  await owner.page.goto('/site')
  await owner.page.getByLabel('Save changes to').selectOption({ label: 'Search and AI 1.7 browser draft · open' })
  await owner.page.getByLabel('Business name').fill('Search and AI browser site')
  await owner.page.getByText('Additional site settings', { exact: true }).click()
  const homepage = owner.page.getByLabel('Homepage')
  if (!await homepage.inputValue()) await homepage.selectOption('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
  const detailsSaved = owner.page.waitForResponse(response => response.url().endsWith('/api/site-workspace') && response.request().method() === 'POST')
    .then(async response => ({ status: response.status(), body: await response.text() }))
  await owner.page.getByRole('button', { name: 'Save business details' }).click()
  const detailsResult = await detailsSaved
  expect(detailsResult.status, detailsResult.body).toBe(200)

  await owner.page.getByRole('button', { name: 'Search and AI' }).click()
  const workspace = owner.page.locator('[data-site-search-ai]')
  await expect(workspace).toBeVisible()
  await expect(workspace.getByRole('heading', { name: 'Crawler access' })).toBeVisible()
  await expect(workspace.getByRole('heading', { name: 'Site description and style' })).toBeVisible()
  await expect(workspace.getByLabel('Search engines')).toBeChecked()
  await expect(workspace.getByLabel('AI search and answers')).toBeChecked()
  await expect(workspace.getByLabel('AI model training')).toBeChecked()
  await expect(workspace).toContainText('Robots.txt is a request to supported crawlers, not access enforcement.')
  await workspace.getByLabel('AI model training').uncheck()
  await workspace.getByLabel('Short description').fill('A reviewed description for public crawler and AI discovery artifacts.')
  await workspace.getByLabel('Words to avoid').fill('empty promise, unsupported claim')
  await workspace.getByLabel('Spelling').selectOption('warn')
  const saved = owner.page.waitForResponse(response => response.url().endsWith('/api/site-workspace') && response.request().method() === 'POST')
    .then(async response => ({ status: response.status(), body: await response.text() }))
  await workspace.getByRole('button', { name: 'Save Search and AI' }).click()
  const saveResult = await saved
  expect(saveResult.status, saveResult.body).toBe(200)
  await expect(owner.page.getByRole('status')).toContainText('Public content is unchanged')

  const sets = await owner.page.request.get('/api/editorial/list').then(response => response.json()) as {
    sets: Array<{ id: string; name: string; state: string; changes: Array<{ collection: string }> }>
  }
  const captured = sets.sets.find(item => item.name === 'Search and AI 1.7 browser draft')
  expect(captured).toMatchObject({ state: 'open' })
  expect(captured?.changes.map(change => change.collection)).toEqual(expect.arrayContaining(['site-settings', 'style-guides']))

  await owner.page.evaluate(() => new Promise<void>(resolve => { scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(() => resolve())) }))
  const cards = workspace.locator('[data-site-search-card]')
  const boxes = await cards.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect()).map(({ x, y, width }) => ({ x, y, width })))
  expect(boxes).toHaveLength(2)
  expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2)
  expect(Math.abs(boxes[0]!.width - boxes[1]!.width)).toBeLessThan(2)
  await axe(owner.page)
  await owner.page.screenshot({ path: testInfo.outputPath('site-search-ai-1440.png'), fullPage: true })

  await owner.page.setViewportSize({ width: 390, height: 844 })
  await owner.page.evaluate(() => new Promise<void>(resolve => { scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(() => resolve())) }))
  const mobileBoxes = await cards.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect()).map(({ y }) => y))
  expect(mobileBoxes[1]).toBeGreaterThan(mobileBoxes[0]!)
  expect(await owner.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(392)
  await axe(owner.page)
  await owner.page.screenshot({ path: testInfo.outputPath('site-search-ai-390.png'), fullPage: true })

  const discarded = await owner.page.request.post('/api/editorial/discard', {
    headers: { origin, 'content-type': 'application/json' },
    data: { id: captured!.id },
  })
  expect(discarded.status(), await discarded.text()).toBe(200)
  await owner.context.close()
})
