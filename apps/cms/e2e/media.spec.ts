import { expect, test, type Browser, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import sharp from 'sharp'

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const sessionToken = 'synthetic-media-owner-session-token'
const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#2563eb' } }).png().toBuffer()
const replacementName = 'replacement-purple.png'
const replacementPng = await sharp({ create: { width: 48, height: 64, channels: 3, background: '#9333ea' } }).png().toBuffer()

async function mediaPage(browser: Browser) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: sessionToken, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  await page.goto('/media')
  await expect(page.getByRole('heading', { name: 'Media', exact: true })).toBeVisible()
  return { context, page }
}

async function axe(page: Page) {
  await page.addScriptTag({ path: axeSource })
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main')).violations)).toEqual([])
}

async function search(page: Page, value: string) {
  await page.getByLabel('Search media').fill(value)
  await page.getByRole('button', { name: 'Search', exact: true }).click()
}

async function renderedFonts(page: Page, selectors: string[]) {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
    const entries = await Promise.all(selectors.map(async (selector) => {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
      expect(nodeId, `Missing font probe target: ${selector}`).not.toBe(0)
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
      return [selector, fonts] as const
    }))
    return Object.fromEntries(entries)
  } finally {
    await cdp.detach()
  }
}

test('ENG-014 keeps drafts behind discard confirmation and ignores an obsolete search response', async ({ browser }) => {
  const session = await mediaPage(browser)
  const page = session.page
  const first = page.locator('[data-media-asset]').first()
  const second = page.locator('[data-media-asset]').nth(1)
  await first.click()
  const firstName = await page.locator('[data-media-detail] h2').innerText()
  await page.locator('#asset-alt').fill('Unsaved browser description')

  page.once('dialog', async (dialog) => { expect(dialog.message()).toContain('Discard unsaved'); await dialog.dismiss() })
  await second.click()
  await expect(page.locator('[data-media-detail] h2')).toHaveText(firstName)
  await expect(page.locator('#asset-alt')).toHaveValue('Unsaved browser description')

  page.once('dialog', async (dialog) => { await dialog.accept() })
  await second.click()
  await expect(page.locator('[data-media-detail] h2')).not.toHaveText(firstName)
  await expect(page.locator('#asset-alt')).not.toHaveValue('Unsaved browser description')

  let markObsoleteStarted!: () => void
  let releaseObsolete!: () => void
  let markObsoleteRouteDone!: () => void
  let markObsoleteSettled!: () => void
  const obsoleteStarted = new Promise<void>((resolve) => { markObsoleteStarted = resolve })
  const obsoleteRelease = new Promise<void>((resolve) => { releaseObsolete = resolve })
  const obsoleteRouteDone = new Promise<void>((resolve) => { markObsoleteRouteDone = resolve })
  const obsoleteSettled = new Promise<void>((resolve) => { markObsoleteSettled = resolve })
  const settleObsolete = (request: import('@playwright/test').Request) => {
    if (new URL(request.url()).searchParams.get('q') === 'obsolete') markObsoleteSettled()
  }
  page.on('requestfinished', settleObsolete)
  page.on('requestfailed', settleObsolete)
  await page.route('**/api/media/workspace?**', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q')
    if (query !== 'obsolete') return route.continue()
    markObsoleteStarted()
    await obsoleteRelease
    await route.fulfill({ status: 200, json: {
      assets: [{ id: 'obsolete-id', filename: 'obsolete.png', mimeType: 'image/png', alt: 'Obsolete result', decorative: false, caption: '', credit: '', tags: [], url: null, usages: [] }],
      total: 1, truncated: false, page: 1, totalPages: 1, pageSize: 24,
    } }).catch(() => undefined)
    markObsoleteRouteDone()
  })
  await page.getByLabel('Search media').fill('obsolete')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await obsoleteStarted
  await page.getByLabel('Search media').fill('media-fixture-01')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.locator('[data-media-asset]')).toHaveCount(1)
  await expect(page.locator('[data-media-asset]')).toContainText('media-fixture-01.png')
  releaseObsolete()
  await Promise.all([obsoleteRouteDone, obsoleteSettled])
  await expect(page.locator('[data-media-asset]')).toHaveCount(1)
  await expect(page.locator('[data-media-asset]')).toContainText('media-fixture-01.png')
  await expect(page.locator('[data-media-asset]')).not.toContainText('obsolete')
  await session.context.close()
})

test('ENG-014 uploads accurate metadata, saves every field, searches, pages, blocks used deletion, and restores from the bin', async ({ browser }) => {
  test.setTimeout(120_000)
  const session = await mediaPage(browser)
  const page = session.page
  const uploadName = `media-ui-${Date.now()}.png`

  await page.getByRole('button', { name: 'Upload new asset' }).first().click()
  await page.getByLabel('Choose image').setInputFiles({ name: uploadName, mimeType: 'image/png', buffer: png })
  await expect(page.getByRole('button', { name: 'Upload image' })).toBeDisabled()
  await page.getByLabel('Alt text', { exact: false }).first().fill('Blue browser test square')
  await page.getByRole('button', { name: 'Upload image' }).click()
  await expect(page.getByRole('status')).toContainText('Image uploaded')
  await expect(page.locator('[data-media-detail] h2')).toHaveText(uploadName)
  const enabledBin = page.getByRole('button', { name: 'Move to bin' })
  await expect(enabledBin).toBeEnabled()
  expect(await enabledBin.evaluate((element) => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, color: style.color }
  })).toEqual({ background: 'rgb(255, 255, 255)', color: 'rgb(160, 39, 32)' })
  await axe(page)

  const focalSurface = page.locator('[data-media-focal]')
  const focalBox = await focalSurface.boundingBox()
  expect(focalBox).not.toBeNull()
  await page.mouse.click(focalBox!.x + focalBox!.width * 0.25, focalBox!.y + focalBox!.height * 0.75)
  await expect(page.getByLabel('Horizontal (%)')).toHaveValue('25')
  await expect(page.getByLabel('Vertical (%)')).toHaveValue('75')
  await focalSurface.press('ArrowRight')
  await focalSurface.press('Shift+ArrowUp')
  await expect(page.getByLabel('Horizontal (%)')).toHaveValue('26')
  await expect(page.getByLabel('Vertical (%)')).toHaveValue('65')
  await page.getByLabel('Horizontal (%)').fill('28')
  await page.getByLabel('Vertical (%)').fill('72')
  for (const crop of ['hero', 'card', 'square']) await expect(page.locator(`[data-media-crop-preview="${crop}"] img`)).toHaveCSS('object-position', '28% 72%')

  await page.locator('#asset-alt').fill('Updated blue browser square')
  await page.getByLabel('Caption').fill('A caption saved through the Media workspace')
  await page.getByLabel('Credit').fill('Synthetic photographer')
  await page.getByLabel('Tags').fill('browser, regression')
  await page.getByRole('button', { name: 'Save metadata' }).click()
  await expect(page.getByRole('status')).toContainText('Metadata saved')

  await search(page, uploadName)
  await expect(page.locator('[data-media-asset]')).toHaveCount(1)
  await expect(page.getByLabel('Caption')).toHaveValue('A caption saved through the Media workspace')
  await expect(page.getByLabel('Credit')).toHaveValue('Synthetic photographer')
  await expect(page.getByLabel('Tags')).toHaveValue('browser, regression')
  await expect(page.getByLabel('Horizontal (%)')).toHaveValue('28')
  await expect(page.getByLabel('Vertical (%)')).toHaveValue('72')
  for (const crop of ['hero', 'card', 'square']) await expect(page.locator(`[data-media-crop-preview="${crop}"] img`)).toHaveCSS('object-position', '28% 72%')
  const stableAssetID = await page.locator('[data-media-detail] header span').innerText()
  await page.getByLabel('Replace file').setInputFiles({ name: replacementName, mimeType: 'image/png', buffer: replacementPng })
  await page.locator('[data-media-replacement] button[type="submit"]').click()
  await expect(page.getByRole('status')).toContainText('Published snapshots retain the previous file')
  await expect(page.locator('[data-media-detail] header span')).toHaveText(stableAssetID)
  await expect(page.locator('[data-media-detail] header')).toContainText('48 × 64')
  await page.reload()
  await search(page, replacementName)
  await expect(page.locator('[data-media-detail] header span')).toHaveText(stableAssetID)
  await expect(page.locator('[data-media-detail] header')).toContainText('48 × 64')

  await search(page, '')
  await expect(page.getByText(/Page 1 of 2/)).toBeVisible()
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('Page 2 of 2')).toBeVisible()
  await page.getByRole('button', { name: 'Previous' }).click()
  await expect(page.getByText('Page 1 of 2')).toBeVisible()

  await search(page, 'media-fixture-00.png')
  const usageLink = page.getByRole('link', { name: 'Media usage fixture page' })
  await expect(usageLink).toHaveAttribute('href', /\/content-editor\/[0-9a-f-]+$/)
  await usageLink.click()
  await expect(page).toHaveURL(/\/content-editor\/[0-9a-f-]+$/)
  await expect(page.getByRole('heading', { name: 'Media usage fixture page' })).toBeVisible()
  await page.goto('/media')
  await search(page, 'media-fixture-00.png')
  await expect(page.getByRole('button', { name: 'Move to bin' })).toBeDisabled()
  const denial = await page.evaluate(async () => {
    const assetID = document.querySelector('[data-media-detail] h2')?.nextElementSibling?.textContent
    const response = await fetch('/api/media/lifecycle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId: assetID, action: 'bin' }) })
    return { status: response.status, body: await response.json() }
  })
  expect(denial.status).toBe(200)
  expect(denial.body).toMatchObject({ status: 'blocked' })

  await search(page, replacementName)
  await page.getByRole('button', { name: 'Move to bin' }).click()
  await expect(page.getByRole('status')).toContainText('Asset moved to the deletion bin')
  await page.getByRole('button', { name: 'Deletion bin' }).click()
  await expect(page.getByRole('button', { name: new RegExp(replacementName) })).toBeVisible()
  await page.getByRole('button', { name: new RegExp(replacementName) }).click()
  await page.getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByRole('status')).toContainText('Asset restored')
  await expect(page.getByRole('button', { name: new RegExp(replacementName) })).toHaveCount(0)
  await session.context.close()
})

test('ENG-014 remains readable and accessible at desktop and narrow mobile widths', async ({ browser }) => {
  const session = await mediaPage(browser)
  const page = session.page
  await page.evaluate(async () => {
    await document.fonts.ready
    window.scrollTo(0, 0)
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  const desktopLayout = await page.locator('[data-media-layout]').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
  const desktopGrid = await page.locator('[data-media-grid]').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
  expect(desktopLayout).toBe(2)
  expect(desktopGrid).toBe(4)
  const libraryBox = await page.locator('[data-media-library]').boundingBox()
  const desktopDetailBox = await page.locator('[data-media-detail]').boundingBox()
  expect(libraryBox).not.toBeNull()
  expect(desktopDetailBox).not.toBeNull()
  expect(Math.abs(libraryBox!.y - desktopDetailBox!.y)).toBeLessThanOrEqual(1)
  const branding = await page.request.get('/admin-branding/admin-branding.css')
  if (branding.ok()) {
    expect(await branding.text()).toContain('[data-media-workspace]')
    const selectors = ['label[for="media-search"]', '[data-media-asset] strong', '#focal-heading', 'label[for="asset-focal-x"]', '[data-media-detail] h2', 'label[for="asset-alt"]', '[data-media-toolbar] button']
    const fonts = await renderedFonts(page, selectors)
    await test.info().attach('media-rendered-fonts.json', { body: Buffer.from(JSON.stringify(fonts, null, 2)), contentType: 'application/json' })
    for (const selector of selectors) {
      const usedFonts = fonts[selector].filter((font) => font.glyphCount > 0)
      expect(usedFonts, `${selector} should render visible glyphs`).not.toHaveLength(0)
      expect(usedFonts, `${selector} should use the bundled IBM Plex Sans semibold face`).toEqual(expect.arrayContaining([
        expect.objectContaining({ postScriptName: 'IBMPlexSans-SmBld', isCustomFont: true }),
      ]))
      expect(usedFonts.every((font) => font.postScriptName.startsWith('IBMPlexSans') && font.isCustomFont)).toBe(true)
    }
    const weights = await page.locator('[data-media-workspace]').evaluate(() => ({
      card: getComputedStyle(document.querySelector('[data-media-asset] strong')!).fontWeight,
      detail: getComputedStyle(document.querySelector('[data-media-detail] h2')!).fontWeight,
      label: getComputedStyle(document.querySelector('label[for="asset-alt"]')!).fontWeight,
      toolbar: getComputedStyle(document.querySelector('[data-media-toolbar] button')!).fontWeight,
    }))
    expect(weights).toEqual({ card: '600', detail: '600', label: '600', toolbar: '600' })
  }
  const detailWidth = await page.locator('[data-media-detail]').evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
  expect(detailWidth.scrollWidth).toBeLessThanOrEqual(detailWidth.clientWidth)
  await axe(page)
  await page.screenshot({ path: 'artifacts/media-1440-branded.png' })

  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.locator('body').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  const mobileLibraryBox = await page.locator('[data-media-library]').boundingBox()
  const detailBox = await page.locator('[data-media-detail]').boundingBox()
  expect(mobileLibraryBox).not.toBeNull()
  expect(detailBox).not.toBeNull()
  expect(detailBox!.y).toBeGreaterThan(mobileLibraryBox!.y + mobileLibraryBox!.height - 2)
  expect(await page.locator('[data-media-grid]').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(2)
  await axe(page)
  await page.screenshot({ path: 'artifacts/media-390-branded.png', fullPage: true })
  await session.context.close()
})
