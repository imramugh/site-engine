import { expect, test, type Browser, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const tokens = {
  owner: 'synthetic-operations-owner-session-token',
  editor: 'synthetic-application-editor-session-token',
  sales: 'synthetic-application-sales-session-token',
  hiring: 'synthetic-application-hiring-session-token',
} as const

async function signedIn(browser: Browser, role: keyof typeof tokens) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: tokens[role], url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  await page.goto('/admin')
  return { context, page }
}

async function searchJSON(page: Page, query: string) {
  return page.evaluate(async value => {
    const response = await fetch(`/api/admin/search?q=${encodeURIComponent(value)}`)
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') }
  }, query)
}

test('ENG-006 searches real permitted records without exposing private lead fields', async ({ browser }) => {
  const owner = await signedIn(browser, 'owner')
  const page = owner.page
  await expect(page.locator('[data-admin-primary] a[href="/leads"] [data-admin-nav-badge]')).toHaveText('1')
  await expect(page.locator('[data-admin-primary] a[href="/editorial"] [data-admin-nav-badge]')).toHaveText('1')

  const requests: string[] = []
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/admin/search') requests.push(request.url()) })
  const input = page.getByRole('combobox', { name: 'Search pages, leads, media' })
  await expect(page.locator('[data-admin-search-icon]')).toBeVisible()
  await expect(page.locator('[data-admin-search-shortcut]')).toHaveText('⌘K')
  await page.keyboard.press('Control+K')
  await expect(input).toBeFocused()
  await input.fill('di')
  await input.fill('dire')
  await input.fill('direct')
  const result = page.getByRole('option', { name: /Direct edit browser page.*Pages/ })
  await expect(result).toBeVisible()
  expect(requests).toHaveLength(1)
  await expect(input).toHaveAttribute('aria-expanded', 'true')
  await input.press('ArrowDown')
  await expect(result).toHaveAttribute('aria-selected', 'true')
  await expect(input).toHaveAttribute('aria-activedescendant', 'admin-search-result-0')
  await input.press('Enter')
  await expect(page).toHaveURL(/\/content-editor\/[0-9a-f-]+$/)
  await expect(page.getByRole('heading', { name: 'Direct edit browser page' })).toBeVisible()

  await page.goto('/admin')
  const lead = await searchJSON(page, 'active-incident')
  expect(lead.status).toBe(200)
  expect(lead.cache).toContain('no-store')
  expect(lead.body.results.Pages).toEqual([])
  expect(lead.body.results.Media).toEqual([])
  expect(lead.body.results.Leads).toHaveLength(1)
  expect(lead.body.results.Leads[0]).toMatchObject({ category: 'Leads', title: 'active-incident' })
  const serialized = JSON.stringify(lead.body)
  expect(serialized).not.toContain('urgent-lead.synthetic@example.test')
  expect(serialized).not.toContain('A synthetic urgent lead.')
  expect(serialized).not.toContain('email')
  expect(serialized).not.toContain('message')

  const tooShort = await page.evaluate(async () => (await fetch('/api/admin/search?q=x')).status)
  expect(tooShort).toBe(400)
  const crossOrigin = await page.request.get('/api/admin/search?q=direct', { headers: { origin: 'https://attacker.example' } })
  expect(crossOrigin.status()).toBe(403)
  const anonymous = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  expect((await anonymous.request.get('/api/admin/search?q=direct', { headers: { origin } })).status()).toBe(401)
  await anonymous.close()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin')
  const mobileSearch = page.getByRole('combobox', { name: 'Search pages, leads, media' })
  await mobileSearch.fill('no-record-has-this-value')
  await expect(page.getByRole('status').filter({ hasText: 'No matching records.' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await mobileSearch.fill('direct')
  await expect(page.getByRole('option')).toHaveCount(1)
  await page.addScriptTag({ path: axeSource })
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run()).violations)).toEqual([])
  await page.screenshot({ path: 'artifacts/playwright-cms/admin-global-search-390-results.png', fullPage: true })
  await mobileSearch.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(mobileSearch).toBeFocused()

  await page.route('**/api/admin/search?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }))
  await mobileSearch.fill('failure')
  await expect(page.getByRole('alert').filter({ hasText: 'Search is unavailable. Try again.' })).toBeVisible()
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run()).violations)).toEqual([])
  await page.screenshot({ path: 'artifacts/playwright-cms/admin-global-search-390-error.png', fullPage: true })
  await owner.context.close()

  const editor = await signedIn(browser, 'editor')
  await expect(editor.page.getByRole('link', { name: 'Reviews', exact: true }).locator('[data-admin-nav-badge]')).toHaveText('1')
  await expect(editor.page.locator('a[href="/leads"]')).toHaveCount(0)
  const editorPages = (await searchJSON(editor.page, 'direct')).body.results.Pages
  expect(editorPages).toHaveLength(1)
  expect(editorPages[0].url).toMatch(/^\/content-editor\/[0-9a-f-]+$/)
  expect((await searchJSON(editor.page, 'active-incident')).body.results.Leads).toEqual([])
  await editor.context.close()

  const sales = await signedIn(browser, 'sales')
  await expect(sales.page.getByRole('link', { name: 'Leads', exact: true }).locator('[data-admin-nav-badge]')).toHaveText('1')
  await expect(sales.page.locator('a[href="/editorial"]')).toHaveCount(0)
  expect((await searchJSON(sales.page, 'direct')).body.results.Pages).toEqual([])
  expect((await searchJSON(sales.page, 'active-incident')).body.results.Leads).toHaveLength(1)
  await sales.page.getByRole('combobox', { name: 'Search pages, leads, media' }).fill('active-incident')
  await sales.page.getByRole('option', { name: /active-incident.*Leads/ }).click()
  await expect(sales.page).toHaveURL(/\/admin\/collections\/inquiries\/[0-9a-f-]+$/)
  await expect(sales.page.getByRole('heading', { name: 'urgent-lead.synthetic@example.test' })).toBeVisible()
  await expect(sales.page.getByText('active-incident', { exact: true })).toBeVisible()
  await sales.context.close()

  const hiring = await signedIn(browser, 'hiring')
  await expect(hiring.page.getByRole('link', { name: 'Careers', exact: true }).locator('[data-admin-nav-badge]')).toHaveText('1')
  await expect(hiring.page.locator('a[href="/leads"], a[href="/editorial"]')).toHaveCount(0)
  expect((await searchJSON(hiring.page, 'direct')).body.results).toEqual({ Pages: [], Media: [], Leads: [] })
  expect((await searchJSON(hiring.page, 'active-incident')).body.results).toEqual({ Pages: [], Media: [], Leads: [] })
  await hiring.context.close()
})
