import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test'
import { createRequire } from 'node:module'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const expectsPreviews = process.env.BLOCK_GALLERY_E2E_EXPECT_PREVIEWS === '1'

async function signedIn(browser: Browser) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-gallery-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}
async function axe(page: Page) {
  await page.addScriptTag({ path: axeSource })
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
}
async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(async () => { scrollTo(0, 0); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame) })
  const path = testInfo.outputPath(name); await page.screenshot({ path, fullPage: true }); await testInfo.attach(name, { path, contentType: 'image/png' })
}

test('ENG-018 renders the complete active-theme library and captures an ordered recipe in the owned change set', async ({ browser }, testInfo) => {
  const { context, page } = await signedIn(browser)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/block-gallery')
  await expect(page.getByRole('heading', { name: 'Block gallery' })).toBeAttached()
  const cards = page.locator('[data-block-gallery-card]')
  await expect(cards).toHaveCount(18)
  await expect(page.getByText(/^Active theme /)).toBeVisible()
  if (expectsPreviews) {
    await expect(cards.locator('[data-block-gallery-preview] img')).toHaveCount(18)
    expect(await cards.locator('[data-block-gallery-preview] img').evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBeTruthy()
  } else await expect(cards.getByText('Rendered preview unavailable for this exact theme version.')).toHaveCount(18)

  await page.getByRole('button', { name: 'article', exact: true }).click()
  const hero = cards.filter({ has: page.getByRole('heading', { name: 'Hero', exact: true }) })
  await expect(hero).toHaveAttribute('data-allowed', 'false')
  await expect(hero.getByRole('button')).toBeDisabled()
  await page.getByRole('button', { name: 'standard', exact: true }).click()
  await page.getByLabel('Draft page').selectOption({ label: 'Gallery recipe target' })

  const callout = cards.filter({ has: page.getByRole('heading', { name: 'Callout', exact: true }) })
  const faq = cards.filter({ has: page.getByRole('heading', { name: 'FAQ', exact: true }) })
  await callout.getByRole('button', { name: '+ Add to recipe' }).click()
  await faq.getByRole('button', { name: '+ Add to recipe' }).click()
  const recipeItems = page.locator('[data-block-gallery-recipe] li')
  await expect(recipeItems).toHaveCount(2)
  await recipeItems.nth(0).getByLabel('Background').selectOption('accent')
  await recipeItems.nth(1).getByRole('button', { name: 'Move faq up' }).click()
  await expect(recipeItems.nth(0)).toContainText('FAQ')
  const exportText = await page.locator('[data-block-gallery-recipe] pre').textContent()
  expect(JSON.parse(exportText ?? '{}')).toMatchObject({ tool: 'create_page_from_recipe', recipeVersion: 1, arguments: { template: 'standard', blocks: [{ type: 'faq' }, { type: 'callout', appearance: { background: 'accent' } }] } })

  const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/block-gallery/recipe') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Insert into draft' }).click()
  const response = await responsePromise
  expect(response.status()).toBe(201)
  const body = await response.json() as { page: { id: string; blocks: Array<{ type: string; appearance: { background: string } }> }; changeSetRevision: number }
  expect(body.changeSetRevision).toBe(1)
  expect(body.page.blocks.map((block) => block.type)).toEqual(['faq', 'callout'])
  expect(body.page.blocks[1]?.appearance.background).toBe('accent')
  const setID = await page.getByLabel('Open change set').inputValue()
  const submitted = await page.request.post('/api/editorial/submit', { headers: { origin, 'content-type': 'application/json' }, data: { id: setID } })
  expect(submitted.ok(), await submitted.text()).toBeTruthy()
  const reviewer = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await reviewer.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-on-page-reviewer-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const prepared = await reviewer.request.post('/api/editorial/prepare-preview', { headers: { origin, 'content-type': 'application/json' }, data: { id: setID, includedChangeKeys: [`pages:${body.page.id}`] } })
  expect(prepared.ok(), await prepared.text()).toBeTruthy()
  expect((await reviewer.request.post('/__e2e/direct-preview-worker')).ok()).toBeTruthy()
  const review = await reviewer.newPage(); await review.goto(`/review/${setID}`)
  const rendered = review.frameLocator('iframe[title="Page review workspace"]').frameLocator('iframe[title="Proposed page"]').locator('[data-block], [data-block-type]')
  await expect(rendered).toHaveCount(2)
  await expect(rendered.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-block') ?? node.getAttribute('data-block-type')))).resolves.toEqual(['faq', 'callout'])
  await reviewer.close()
  await expect(page.locator('[data-block-gallery-recipe] [role="status"]')).toContainText('captured in the selected draft change set')
  await axe(page)
  await screenshot(page, testInfo, 'block-gallery-1440.png')

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('[data-block-gallery-recipe]')).toHaveCSS('position', 'static')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
  await axe(page)
  await screenshot(page, testInfo, 'block-gallery-390.png')
  await context.close()
})
