import { expect, test, type Browser, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`

async function session(browser: Browser, token: string) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}
async function axe(page: Page) {
  await page.addScriptTag({ path: axeSource })
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
}

test('Site workspace captures real settings, guidance, and redirects into an owned draft', async ({ browser }, testInfo) => {
  const owner = await session(browser, 'synthetic-site-owner-session-token')
  await owner.page.goto('/site')
  await expect(owner.page.locator('[data-site-workspace]')).toBeVisible()
  await expect(owner.page.getByRole('button', { name: 'Business details', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(owner.page.getByRole('link', { name: 'Site', exact: true })).toHaveAttribute('aria-current', 'page')
  await owner.page.getByLabel('New change set name').fill('Browser Site workspace draft')
  await owner.page.getByRole('button', { name: 'Create change set' }).click()
  await expect(owner.page.getByRole('status')).toContainText('is ready')

  await owner.page.getByLabel('Business name').fill('Synthetic Site Workspace')
  await owner.page.getByLabel('Legal name').fill('Synthetic Site Workspace Incorporated')
  await owner.page.getByLabel(/Phone/).fill('+1 555 010 0260')
  await owner.page.getByLabel('Street address').fill('100 Example Road')
  await owner.page.getByLabel('City').fill('Toronto')
  await owner.page.getByLabel('Province or region').fill('ON')
  await owner.page.getByLabel('Postal code').fill('M5V 2T6')
  await owner.page.getByLabel('LinkedIn URL').fill('https://www.linkedin.com/company/synthetic-site-workspace')
  await owner.page.getByLabel('Label').fill('Incident in progress?')
  await owner.page.getByLabel('Guidance').fill('Call the incident line and preserve affected systems.')
  const firstLogo = owner.page.locator('[data-site-details-card=logos] select').first()
  if (await firstLogo.locator('option').count() > 1) await firstLogo.selectOption({ index: 1 })
  await owner.page.getByRole('button', { name: 'Save business details' }).click()
  await expect(owner.page.getByRole('status')).toContainText('Public content is unchanged')
  await owner.page.setViewportSize({ width: 1440, height: 1000 })
  await owner.page.evaluate(() => new Promise<void>(resolve => { scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(() => resolve())) }))
  const desktop = testInfo.outputPath('site-business-details-1440.png'); await owner.page.screenshot({ path: desktop, fullPage: true }); await testInfo.attach('Site Business details 1440', { path: desktop, contentType: 'image/png' })

  await owner.page.getByRole('button', { name: 'Redirects' }).click()
  await expect(owner.page).toHaveURL(/tab=redirects/)
  await owner.page.getByLabel('Old address').fill('/site-workspace-old')
  await owner.page.getByLabel('Goes to').fill('/contact')
  await owner.page.getByRole('button', { name: 'Add redirect' }).click()
  await expect(owner.page.getByRole('cell', { name: '/site-workspace-old' })).toBeVisible()

  await owner.page.getByRole('button', { name: 'Search and AI' }).click()
  await owner.page.getByLabel('Words or phrases to avoid').fill('empty promise\nunsupported claim')
  await owner.page.getByLabel('Canadian spelling').selectOption('warn')
  await owner.page.getByRole('button', { name: 'Save writing guidance' }).click()
  await expect(owner.page.getByRole('status')).toContainText('Public content is unchanged')

  const sets = await owner.page.request.get('/api/editorial/list').then(response => response.json()) as { sets: Array<{ name: string; state: string; changes: Array<{ collection: string }> }> }
  const captured = sets.sets.find(item => item.name === 'Browser Site workspace draft')
  expect(captured).toMatchObject({ state: 'open' })
  expect(captured?.changes.map(change => change.collection)).toEqual(expect.arrayContaining(['site-settings', 'style-guides', 'redirects']))
  expect(await owner.page.request.get('/__e2e/publish-state').then(response => response.json())).toMatchObject({ releaseCount: 1 })

  await owner.page.getByRole('button', { name: 'Navigation' }).click()
  await owner.page.getByRole('button', { name: 'Add header link' }).click()
  const navigationSaved = owner.page.waitForResponse(response => response.url().endsWith('/api/site-workspace') && response.request().method() === 'POST')
  await owner.page.getByRole('button', { name: 'Save navigation' }).click(); expect((await navigationSaved).status()).toBe(200)
  await expect(owner.page.getByRole('status')).toContainText('Public content is unchanged')
  await expect(owner.page.getByRole('link', { name: 'Edit pages and structure in Content' })).toHaveAttribute('href', '/content-tree')
  await owner.page.getByRole('button', { name: 'Theme' }).click()
  await expect(owner.page.getByRole('heading', { name: 'Themes' })).toBeVisible()
  await axe(owner.page)

  await owner.page.setViewportSize({ width: 390, height: 844 })
  await owner.page.getByRole('button', { name: 'Redirects' }).click()
  expect(await owner.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(392)
  expect(await owner.page.locator('[data-site-panel=redirects] div').last().evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
  await owner.page.getByRole('button', { name: 'Business details', exact: true }).click()
  await owner.page.evaluate(() => new Promise<void>(resolve => { scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(() => resolve())) }))
  const mobile = testInfo.outputPath('site-business-details-390.png'); await owner.page.screenshot({ path: mobile, fullPage: true }); await testInfo.attach('Site Business details 390', { path: mobile, contentType: 'image/png' })
  await axe(owner.page)
  await owner.context.close()
})

test('Site workspace rejects non-owners and cross-origin writes', async ({ browser }) => {
  const editor = await session(browser, 'synthetic-application-editor-session-token')
  expect((await editor.page.request.get('/api/site-workspace')).status()).toBe(403)
  await editor.page.goto('/site')
  await expect(editor.page).toHaveURL(/\/admin\/login/)
  await editor.context.close()

  const owner = await session(browser, 'synthetic-site-owner-session-token')
  const response = await owner.page.request.post('/api/site-workspace', { headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, data: {} })
  expect(response.status()).toBe(403)
  const otherOwner = await session(browser, 'synthetic-theme-owner-session-token')
  const foreignSet = await otherOwner.page.request.post('/api/editorial/create', { headers: { origin, 'content-type': 'application/json' }, data: { name: 'Foreign Site draft' } }).then(result => result.json()) as { id: string; revision: number }
  const current = await owner.page.request.get('/api/site-workspace').then(result => result.json()) as { settings: Record<string, unknown>; settingsHash: string }
  const foreignWrite = await owner.page.request.post('/api/site-workspace', { headers: { origin, 'content-type': 'application/json' }, data: { action: 'settings', changeSetID: foreignSet.id, expectedRevision: foreignSet.revision, expectedHash: current.settingsHash, value: current.settings } })
  expect(foreignWrite.status()).toBe(400)
  expect(await foreignWrite.json()).toMatchObject({ error: expect.stringContaining('not owned') })
  await otherOwner.context.close()
  await owner.context.close()
})
