import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test'
import { createRequire } from 'node:module'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

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

async function expectRenderedPreview(page: Page, kind: 'block' | 'template' | 'preset' | 'extension', expectedID?: string) {
  const library = page.frameLocator('iframe[title="Active-theme gallery preview"]')
  await expect(library.locator('[data-gallery-library]')).toBeVisible()
  const selected = library.locator(`[data-gallery-selection][data-gallery-preview-kind="${kind}"]`)
  await expect(selected).toBeVisible()
  const id = await selected.getAttribute('data-gallery-preview-id')
  expect(id).toBeTruthy()
  if (expectedID) expect(id).toBe(expectedID)
  await expect(library.locator('[data-gallery-renderer]')).toHaveCount(1)
  await expect(library.frameLocator('[data-gallery-renderer]').locator(`[data-gallery-preview-kind="${kind}"][data-gallery-preview-id="${id}"]`)).toBeVisible()
}

test('ENG-018 renders the complete active-theme library and captures an ordered recipe in the owned change set', async ({ browser }, testInfo) => {
  test.setTimeout(120_000)
  const { context, page } = await signedIn(browser)
  try {
    const installedTheme = await page.request.post('/__e2e/block-gallery-theme/install')
    expect(installedTheme.ok(), await installedTheme.text()).toBeTruthy()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/block-gallery')
    await expect(page.getByRole('heading', { name: 'Block gallery' })).toBeAttached()
    const activeThemePreview = page.locator('[aria-label="Active-theme preview"]')
    await expect(activeThemePreview).toBeVisible()
    await expect(page.getByText('Rendered preview unavailable for this exact theme version.')).toHaveCount(0)
    await page.locator('[data-gallery-kind="block"]').click()
    await page.getByRole('button', { name: 'Preview Hero', exact: true }).click()
    await expect(activeThemePreview).toHaveAttribute('open', '')
    await expect(activeThemePreview.locator('iframe[title="Active-theme gallery preview"]')).toHaveCount(1)
    await expectRenderedPreview(page, 'block', 'hero')
    for (const kind of ['template', 'preset'] as const) {
      await page.locator(`[data-gallery-kind="${kind}"]`).click()
      await expectRenderedPreview(page, kind)
    }
    await page.locator('[data-gallery-kind="extension"]').click()
    const galleryLibrary = page.frameLocator('iframe[title="Active-theme gallery preview"]')
    await expect(galleryLibrary.locator('[data-gallery-empty-extensions][data-gallery-extension-count="0"]')).toBeVisible()
    await expect(galleryLibrary.locator('[data-gallery-renderer]')).toBeHidden()
    await page.locator('[data-gallery-kind="block"]').click()
    const cards = page.locator('[data-block-gallery-card]')
    await expect(cards).toHaveCount(18)
    await expect(page.getByText(/^Active theme /)).toBeVisible()

    await page.getByRole('button', { name: 'article', exact: true }).click()
    const hero = cards.filter({ has: page.getByRole('heading', { name: 'Hero', exact: true }) })
    await expect(hero).toHaveAttribute('data-allowed', 'false')
    await expect(hero.getByRole('button', { name: '+ Add to recipe' })).toBeDisabled()
    await page.getByRole('button', { name: 'standard', exact: true }).click()
    await page.getByLabel('Draft page').selectOption({ label: 'Gallery recipe target' })
    await page.getByLabel('Open change set').selectOption({ label: 'Scoped block gallery recipe' })

    const callout = cards.filter({ has: page.getByRole('heading', { name: 'Callout', exact: true }) })
    const faq = cards.filter({ has: page.getByRole('heading', { name: 'FAQ', exact: true }) })
    const testimonials = cards.filter({ has: page.getByRole('heading', { name: 'Testimonials', exact: true }) })
    const media = cards.filter({ has: page.getByRole('heading', { name: 'Media', exact: true }) })
    await callout.getByRole('button', { name: '+ Add to recipe' }).click()
    await faq.getByRole('button', { name: '+ Add to recipe' }).click()
    const recipeItems = page.locator('[data-block-gallery-recipe] li')
    await expect(recipeItems).toHaveCount(2)
    await recipeItems.nth(0).getByLabel('Background').selectOption('accent')
    await recipeItems.nth(1).getByRole('button', { name: 'Move faq up' }).click()
    await expect(recipeItems.nth(0)).toContainText('FAQ')
    await testimonials.getByRole('button', { name: '+ Add to recipe' }).click()
    await media.getByRole('button', { name: '+ Add to recipe' }).click()
    await expect(recipeItems).toHaveCount(4)
    const testimonial = recipeItems.nth(2)
    await testimonial.getByRole('textbox', { name: 'Quotation', exact: true }).fill('A synthetic, consent-confirmed testimonial used only for browser acceptance coverage.')
    await testimonial.getByRole('textbox', { name: 'Attribution', exact: true }).fill('Synthetic customer')
    await testimonial.getByLabel('I have permission to publish this quotation.').check()
    const mediaItem = recipeItems.nth(3)
    await mediaItem.getByLabel('Image').selectOption({ label: 'media-fixture-00.png' })
    const mediaID = await mediaItem.getByLabel('Image').inputValue()
    expect(mediaID).toMatch(/^[0-9a-f-]{36}$/i)
    const exportText = await page.locator('[data-block-gallery-recipe] pre').textContent()
    expect(JSON.parse(exportText ?? '{}')).toMatchObject({ tool: 'create_page_from_recipe', recipeVersion: 1, arguments: { template: 'standard', blocks: [{ type: 'faq' }, { type: 'callout', appearance: { background: 'accent' } }, { type: 'testimonials', fields: { items: [{ quote: 'A synthetic, consent-confirmed testimonial used only for browser acceptance coverage.', attribution: 'Synthetic customer', permissionConfirmed: true }] } }, { type: 'media', fields: { mediaId: mediaID } }] } })

    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/block-gallery/recipe') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Insert into draft' }).click()
    const response = await responsePromise
    const responseText = await response.text()
    expect(response.status(), responseText).toBe(201)
    const body = JSON.parse(responseText) as { page: { id: string; blocks: Array<{ type: string; appearance: { background: string }; items?: Array<{ quote: string; attribution: string; permissionConfirmed: boolean }>; mediaId?: string }> }; changeSetRevision: number }
    expect(body.changeSetRevision).toBe(1)
    expect(body.page.blocks.map((block) => block.type)).toEqual(['faq', 'callout', 'testimonials', 'media'])
    expect(body.page.blocks[1]?.appearance.background).toBe('accent')
    expect(body.page.blocks[2]?.items).toEqual([{ quote: 'A synthetic, consent-confirmed testimonial used only for browser acceptance coverage.', attribution: 'Synthetic customer', permissionConfirmed: true }])
    expect(body.page.blocks[3]?.mediaId).toBe(mediaID)

    const setID = await page.getByLabel('Open change set').inputValue()
    const submitted = await page.request.post('/api/editorial/submit', { headers: { origin, 'content-type': 'application/json' }, data: { id: setID } })
    expect(submitted.ok(), await submitted.text()).toBeTruthy()
    const reviewer = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
    try {
      await reviewer.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-on-page-reviewer-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
      const prepared = await reviewer.request.post('/api/editorial/prepare-preview', { headers: { origin, 'content-type': 'application/json' }, data: { id: setID, includedChangeKeys: [`pages:${body.page.id}`] } })
      expect(prepared.ok(), await prepared.text()).toBeTruthy()
      const renderedPreview = await reviewer.request.post('/__e2e/direct-preview-worker')
      expect(renderedPreview.ok(), await renderedPreview.text()).toBeTruthy()
      const review = await reviewer.newPage()
      await review.goto(`/review/${setID}?pageID=${body.page.id}`)
      const rendered = review.frameLocator('iframe[title="Proposed page"]').locator('[data-block], [data-block-type]')
      await expect(rendered).toHaveCount(4)
      await expect(rendered.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-block') ?? node.getAttribute('data-block-type')))).resolves.toEqual(['faq', 'callout', 'testimonials', 'media'])
    } finally {
      const requested = await reviewer.request.post('/api/editorial/request-changes', { headers: { origin, 'content-type': 'application/json' }, data: { id: setID } })
      expect(requested.ok(), await requested.text()).toBeTruthy()
      await reviewer.close()
    }
    const discarded = await page.request.post('/api/editorial/discard', { headers: { origin, 'content-type': 'application/json' }, data: { id: setID } })
    expect(discarded.ok(), await discarded.text()).toBeTruthy()
    await expect(page.locator('[data-block-gallery-recipe] [role="status"]')).toContainText('captured in the selected draft change set')
    await axe(page)
    await screenshot(page, testInfo, 'block-gallery-1440.png')

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('[data-block-gallery-recipe]')).toHaveCSS('position', 'static')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
    await axe(page)
    await screenshot(page, testInfo, 'block-gallery-390.png')
  } finally {
    const restoredTheme = await page.request.post('/__e2e/block-gallery-theme/restore')
    expect(restoredTheme.ok(), await restoredTheme.text()).toBeTruthy()
    await context.close()
  }
})
