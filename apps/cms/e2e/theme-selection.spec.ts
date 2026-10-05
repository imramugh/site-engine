import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const e2ePort = Number(process.env.CMS_E2E_PORT ?? 4300)
const cmsOrigin = `https://127.0.0.1:${e2ePort}`

async function signedInOwner(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: cmsOrigin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: 'synthetic-theme-owner-session-token', url: cmsOrigin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

async function rolePage(browser: Browser, role: 'editor' | 'sales'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: cmsOrigin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: `synthetic-application-${role}-session-token`, url: cmsOrigin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

async function openAdminNavigation(page: Page): Promise<void> {
  const menu = page.getByTestId('mobile-menu')
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') === 'false') await menu.click()
}

test('ENG-035 lets an Owner choose a compatible installed theme into a named reviewed change set', async ({ browser }) => {
  const owner = await signedInOwner(browser)
  const publicationBefore = await owner.page.request.get('/__e2e/publish-state').then(response => response.json())
  await owner.page.goto('/themes')
  await openAdminNavigation(owner.page)
  await expect(owner.page.getByRole('link', { name: 'Site', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(owner.page.getByText('More tools', { exact: true })).toHaveCount(0)
  await expect(owner.page).toHaveURL(/\/themes$/)
  await expect(owner.page.getByRole('heading', { name: 'Themes' })).toBeVisible()
  await expect(owner.page.getByLabel('Current theme selections')).toContainText('No explicit theme')
  const card = owner.page.locator('[data-theme-card][data-theme-family="browser-theme"]')
  await expect(card).toHaveAttribute('data-theme-status', 'available')
  await card.getByRole('button', { name: 'Create reviewed preview' }).click()
  await card.getByLabel('Reviewed draft name').fill('Switch synthetic browser theme')
  let failPreparation = true
  await owner.page.route('**/api/editorial/prepare-preview', async route => {
    if (failPreparation) { failPreparation = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic renderer queue interruption.' }) }); return }
    await route.continue()
  })
  const created = owner.page.waitForResponse((response) => response.url().endsWith('/api/themes') && response.request().method() === 'POST')
  await card.getByRole('button', { name: 'Create reviewed draft and preview' }).click()
  const createdResponse = await created
  expect(createdResponse.status()).toBe(201)
  const createdBody = await createdResponse.json() as { changeSet: { id: string; name: string }; selection: { id: string; version: string }; reused: boolean }
  expect(createdBody).toMatchObject({ changeSet: { name: 'Switch synthetic browser theme' }, selection: { id: 'browser-theme', version: '2.4.6' } })
  await expect(owner.page.getByRole('status')).toContainText('Synthetic renderer queue interruption')
  await owner.page.unroute('**/api/editorial/prepare-preview')
  const reused = owner.page.waitForResponse((response) => response.url().endsWith('/api/themes') && response.request().method() === 'POST')
  await card.getByRole('button', { name: 'Create reviewed draft and preview' }).click()
  const reusedResponse = await reused
  expect(reusedResponse.status()).toBe(200)
  expect(await reusedResponse.json()).toMatchObject({ changeSet: { id: createdBody.changeSet.id }, reused: true })
  await expect(owner.page.getByRole('status')).toContainText('protected preview is queued')
  const worker = await owner.page.request.post('/__e2e/direct-preview-worker')
  expect(worker.status(), await worker.text()).toBe(200)
  await expect(card.getByRole('link', { name: 'Open protected preview' })).toHaveAttribute('href', `/review/${createdBody.changeSet.id}`, { timeout: 10_000 })
  await expect(owner.page.getByLabel('Current theme selections')).toContainText('Reviewed draft Browser Theme 2.4.6')
  expect(await owner.page.request.get(`${cmsOrigin}/__e2e/publish-state`).then(async (response) => response.json())).toMatchObject({ releaseCount: publicationBefore.releaseCount })
  for (const width of [1440, 390]) {
    await owner.page.setViewportSize({ width, height: 900 })
    await owner.page.evaluate(() => new Promise<void>(resolve => { scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(() => resolve())) }))
    expect(await owner.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    await owner.page.addScriptTag({ path: axeSource })
    expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
    await owner.page.screenshot({ path: test.info().outputPath(`themes-${width}.png`), fullPage: true })
  }
  await owner.context.close()
})

test('ENG-035 reports incompatibility and limits theme selection to installed owner-only metadata', async ({ browser }) => {
  const owner = await signedInOwner(browser)
  const metadata = await owner.page.request.get('/api/themes')
  expect(metadata.status()).toBe(200)
  const body = await metadata.json() as { themes: Array<{ id: string; manifestDigest: string; compatibility: { compatible: boolean } }> }
  expect(body.themes.find((theme) => theme.id === 'browser-theme')?.compatibility.compatible).toBe(true)
  expect(body.themes.find((theme) => theme.id === 'browser-theme')?.manifestDigest).toMatch(/^[a-f0-9]{64}$/)
  expect(body.themes.find((theme) => theme.id === 'incomplete-browser-theme')?.compatibility.compatible).toBe(false)
  expect(JSON.stringify(body)).not.toContain('./dist/')
  await owner.page.goto('/themes')
  const incompatible = owner.page.locator('[data-theme-card][data-theme-family="incomplete-browser-theme"]')
  await expect(incompatible).toContainText('Current content is not compatible.')
  await expect(incompatible).toHaveAttribute('data-theme-status', 'needs-upgrade')
  await expect(incompatible.getByRole('button', { name: 'Create reviewed preview' })).toBeDisabled()
  const hostile = await owner.page.request.post('/api/themes', { headers: { origin: cmsOrigin, 'content-type': 'application/json' }, data: { id: '<img src=x onerror=alert(1)>', version: '1.0.0', changeSetName: '<script>alert(1)</script>' } })
  expect(hostile.status()).toBe(400)
  expect(JSON.stringify(await hostile.json())).not.toContain('<script>')
  await owner.context.close()
})

test('ENG-035 denies non-Owners and rejects cross-origin theme selection requests', async ({ browser }) => {
  for (const role of ['editor', 'sales'] as const) {
    const denied = await rolePage(browser, role)
    expect((await denied.page.request.get('/api/themes')).status()).toBe(403)
    await denied.page.goto('/themes')
    await expect(denied.page.getByRole('status')).toContainText('Owner access is required')
    await denied.context.close()
  }
  const owner = await signedInOwner(browser)
  const csrf = await owner.page.request.post('/api/themes', { headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, data: { id: 'browser-theme', version: '2.4.6', changeSetName: 'Blocked cross-origin selection' } })
  expect(csrf.status()).toBe(403)
  await owner.context.close()
})
