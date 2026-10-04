import { expect, test, type Browser, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`

async function pageFor(browser: Browser, role: 'owner' | 'sales' | 'hiring') {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  const token = role === 'owner' ? 'synthetic-operations-owner-session-token' : `synthetic-application-${role}-session-token`
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

async function installAxe(page: Page) {
  await page.addScriptTag({ path: axeSource })
  return page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run()).violations)
}

test('ENG-006 renders the role-aware admin shell at desktop and mobile widths', async ({ browser }) => {
  const owner = await pageFor(browser, 'owner')
  await owner.page.setViewportSize({ width: 1440, height: 900 })
  await owner.page.goto('/admin')

  const sidebar = owner.page.locator('[data-admin-sidebar]')
  await expect(sidebar).toBeVisible()
  await expect(sidebar).toHaveCSS('width', '240px')
  await expect(owner.page.locator('[data-admin-header]')).toBeVisible()
  await expect(owner.page.locator('[data-admin-page-title]')).toHaveText('Dashboard')
  await expect(owner.page.locator('[data-admin-view-site]')).toHaveAttribute('href', '/')
  await expect(owner.page.locator('[data-admin-primary] [data-admin-nav-item]')).toHaveText(['Dashboard', 'Content', 'Block gallery', 'Media', 'Leads', 'Careers', 'Reviews', 'Changelog'])
  await expect(owner.page.locator('[data-admin-secondary] [data-admin-nav-item]')).toHaveText(['Integrations', 'Users'])
  await expect(owner.page.locator('[data-admin-nav-separator]')).toHaveCount(1)
  await owner.page.locator('[data-admin-account-button]').click()
  await expect(owner.page.getByRole('menuitem', { name: 'Log out' })).toHaveAttribute('href', '/admin/logout')
  await owner.page.screenshot({ path: 'artifacts/playwright-cms/admin-shell-1440.png', fullPage: true })
  expect(await installAxe(owner.page)).toEqual([])

  await owner.page.setViewportSize({ width: 390, height: 844 })
  const menu = owner.page.getByTestId('mobile-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  await expect(owner.page.locator('[data-admin-navigation]')).toBeHidden()
  await menu.click()
  await expect(menu).toHaveAttribute('aria-expanded', 'true')
  await expect(owner.page.locator('[data-admin-navigation]')).toBeVisible()
  await expect(owner.page.locator('[data-admin-sidebar]')).toHaveCSS('width', '390px')
  await owner.page.keyboard.press('Escape')
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  await expect(menu).toBeFocused()
  await owner.page.screenshot({ path: 'artifacts/playwright-cms/admin-shell-390.png', fullPage: true })
  await menu.click()
  expect(await installAxe(owner.page)).toEqual([])
  await owner.context.close()

  const sales = await pageFor(browser, 'sales')
  await sales.page.goto('/admin')
  await expect(sales.page.locator('[data-admin-primary] [data-admin-nav-item]')).toHaveText(['Dashboard', 'Leads'])
  await expect(sales.page.locator('[data-admin-secondary]')).toHaveCount(0)
  await sales.page.goto('/content-tree')
  await expect(sales.page).toHaveURL(/\/admin\/login/)
  await sales.context.close()

  const hiring = await pageFor(browser, 'hiring')
  await hiring.page.goto('/admin')
  await expect(hiring.page.locator('[data-admin-primary] [data-admin-nav-item]')).toHaveText(['Dashboard', 'Careers'])
  await hiring.context.close()
})
